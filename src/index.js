'use strict';

var redis = require('redis');
var Scripty = require('node-redis-scripty');
var EventEmitter = require('events').EventEmitter;

/**
 * Lock constructor.
 *
 * @param {Object} options
 *   @property {String} redis Redis connection string.
 *   @property {String=} namespace - An optional namespace under which to prefix all Redis keys and
 *     channels used by this lock.
 */
function Lock(options) {
  options = options || {};
  options.namespace = options.namespace || 'lock';

  this._namespace = options.namespace;

  // Create Redis connection for issuing normal commands
  this._redisConnection = redis.createClient(options.redis);

  // Handler to run LUA scripts. Uses caching if possible
  this._scripty = new Scripty(this._redisConnection);

  // Redis connection with subscribers is not allowed to issue commands
  // so we need an extra connection to handle subscription messages
  this._redisSubscriber = redis.createClient(options.redis);

  // Create event handler to register waiting locks
  this._subscribers = new EventEmitter();
  this._subscribers.setMaxListeners(Infinity);

  // Whenever a lock is released it is published to the namespaced '-release' channel
  // using the lock key as the message.
  this._redisSubscriber.subscribe(`${this._namespace}-release`);
  this._redisSubscriber.on('message', (channel, message) => {
    if (channel !== `${this._namespace}-release` || !this._subscribers.listenerCount(message)) {
      // just ignore, nothing to do here
      return;
    }

    // Notify all waiting instances about the released lock
    this._subscribers.emit(message);
  });
}

Object.assign(Lock.prototype, {
  /**
   * Acquire a lock for a specific ID value. Callback returns the following value:
   *
   *   {
   *     id: Message ID
   *     success: either true (lock was acquired) of false (lock was not aquired)
   *     state: state value for current lock
   *     index: modification index for current lock
   *     ttl: expiration time for the lock
   *   }
   *
   * Lock index is a shared incrementing number (signed 64bit) that should ensure rogue
   * lock holders would not be able to mess with newer locks for the same resource.
   *
   * @param {String} id Identifies the lock
   * @param {String} state Informational text about the current state ('create', 'update', 'delete')
   * @param {Number} ttl Automatically release lock after TTL (ms). Must be positive integer
   * @param {Function} done Callback
   */
  acquireLock: function(id, state, ttl, done) {
    var acquireScript = `
        local ttl=tonumber(ARGV[2]);
        if redis.call("EXISTS", KEYS[1]) == 1 then
          local data = {
            ["state"]=redis.call("HGET", KEYS[1], "state"),
            ["index"]=tonumber(redis.call("HGET", KEYS[1], "index"))
          };
          return {0, data.state, data.index, redis.call("PTTL", KEYS[1])};
        end;
        --[[
          Use a global incrementing counter
          It is a signed 64bit integer, so it should not overflow any time soon.
          The number gets converted to JS which uses 64bit floats but even if the
          boundary would be much smaller Number.MAX_SAFE_INTEGER it would take thousands
          of years to reach that limit assuming we make 100k incrementations in a second
        --]]
        local index = redis.call("INCR", KEYS[2]);
        redis.call("HMSET", KEYS[1], "state", ARGV[1], "index", index);
        redis.call("PEXPIRE", KEYS[1], ttl);
        return {1, ARGV[1], index, ttl};
      `;

    this._scripty.loadScript('acquireScript', acquireScript, (err, script) => {
      if (err) return done(err);

      script.run(2, `${this._namespace}:${id}`, `${this._namespace}index`, state, ttl, (err, evalResponse) => {
        if (err) return done(err);

        var response = {
          id: id,
          success: !!evalResponse[0],
          state: evalResponse[1],
          index: evalResponse[2],
          ttl: evalResponse[3]
        };
        done(null, response);
      });
    });
  },

  /**
   * Releases a lock. Operation only succeeds if a correct modification index is provided.
   * If modification index has been changed then it should indicate that the previously held
   * lock was expired in the meantime and someone has already acquired a new lock for the same id.
   * If lock is not released manually then it expires automatically after the ttl
   *
   * Callback returns the following value:
   *
   *   {
   *     id: Message ID
   *     success: either true (lock was released or did not exist) of false (lock was not released)
   *     result: status text. Either 'expired', 'released' or 'conflict'
   *   }
   *
   * @param {String} id Identifies the lock
   * @param {Number} index Modification index of the previously acquired lock
   * @param {Function} done Callback
   */
  releaseLock: function(id, index, done) {
    var releaseScript = `
        local index = tonumber(ARGV[1]);
        if redis.call("EXISTS", KEYS[1]) == 0 then
          return {1, "expired", "expired", 0};
        end;
        local data = {
          ["state"]=redis.call("HGET", KEYS[1], "state"),
          ["index"]=tonumber(redis.call("HGET", KEYS[1], "index"))
        };
        if data.index == index then
          redis.call("DEL", KEYS[1]);
          -- Notify potential queue that this lock is now freed
          redis.call("PUBLISH", "${this._namespace}-release", KEYS[1]);
          return {1, "released", data.state, data.index};
        end;
        return {0, "conflict", data.state, data.index};
      `;

    this._scripty.loadScript('releaseScript', releaseScript, (err, script) => {
      if (err) return done(err);

      script.run(1, `${this._namespace}:${id}`, index, (err, evalResponse) => {
        if (err) return done(err);

        var response = {
          id: id,
          success: !!evalResponse[0],
          result: evalResponse[1],
          state: evalResponse[2],
          index: evalResponse[3]
        };
        done(null, response);
      });
    });
  },

  /**
   * Acquire a lock for a specific ID value. If the lock is not available then waits
   * up to {waitTtl} milliseconds before giving up. The callback returns the following values:
   *
   *   {
   *     id: Message ID
   *     success: either true (lock was acquired) of false (lock was not aquired by given ttl)
   *     state: state value for current lock
   *     index: modification index for current lock
   *     ttl: expiration time for the lock
   *   }
   *
   * @param {String} id Identifies the lock
   * @param {String} state Informational text about the current state ('create', 'update', 'delete')
   * @param {Number} ttl Automatically release acquired lock after TTL (ms). Must be positive integer
   * @param {Number} waitTtl Give up until ttl (in ms) or wait indefinitely if value is 0
   * @param {Function} done Callback
   */
  waitAcquireLock: function(id, state, lockTtl, waitTtl, done) {
    var expired = false; // flag to indicate that the TTL wait time was expired
    var acquiring = false; // flag to indicate that a Redis query is in process

    var ttlTimer;
    var expireLockTimer;

    if (waitTtl > 0) {
      expireLockTimer = setTimeout(() => {
        expired = true;
        this._subscribers.removeListener(`${this._namespace}:${id}`, tryAcquire);
        clearTimeout(ttlTimer);
        // Try one last time and return whatever the acquireLock returns
        if (!acquiring) {
          return tryAcquire();
        }
      }, waitTtl);
    }

    // A looping function that tries to acquire a lock. The loop goes on until
    // the lock is acquired or the wait ttl kicks in
    var tryAcquire = () => {
      this._subscribers.removeListener(`${this._namespace}:${id}`, tryAcquire); // clears pubsub listener
      clearTimeout(ttlTimer); // clears the timer that waits until existing lock is expired
      acquiring = true;
      this.acquireLock(id, state, lockTtl, (err, lock) => {
        acquiring = false;
        if (err) {
          // stop waiting if we hit into an error
          clearTimeout(expireLockTimer);
          return done(err);
        }
        if (lock.success || expired) {
          // we got a lock or the wait TTL was expired, return what we have
          clearTimeout(expireLockTimer);
          return done(null, lock);
        }

        // Wait for either a Redis publish event or for the lock expiration timer to expire
        this._subscribers.addListener(`${this._namespace}:${id}`, tryAcquire);
        // Remaining TTL for the lock might be very low, even 0 (lock expires by next ms)
        // in any case we do not make a next polling try sooner than after 100ms delay
        // We might make the call sooner if the key is released manually and we get a notification
        // from Redis PubSub about it
        ttlTimer = setTimeout(tryAcquire, Math.max(lock.ttl || 100));
      });
    };

    // try to acquire a lock
    tryAcquire();
  }
});

module.exports = Lock;