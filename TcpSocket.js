/**
 * Copyright (c) 2015-present, Peel Technologies, Inc.
 * All rights reserved.
 *
 * @providesModule TcpSocket
 * @flow
 */

'use strict';

var inherits = require('inherits');
var EventEmitter = require('events').EventEmitter;
var ipRegex = require('ip-regex');
var {
  DeviceEventEmitter,
  NativeModules
} = require('react-native');
var Sockets = NativeModules.TcpSockets;
var base64 = require('base64-js');
var Base64Str = require('./base64-str');
var noop = function () {};
var usedIds = [];
var STATE = {
  DISCONNECTED: 0,
  CONNECTING: 1,
  CONNECTED: 2
};

function TcpSocket(options: ?any) {
  // $FlowFixMe: suppressing this error flow doesn't like EventEmitter
  EventEmitter.call(this);

  options = options || {};

  var nativeSocket = false;
  if (!options._id) {
    // javascript generated sockets range from 1-1000
    this._id = Math.floor((Math.random() * 1000) + 1);
    while (usedIds.indexOf(this._id) !== -1) {
      this._id = Math.floor((Math.random() * 1000) + 1);
    }
  } else {
    // native generated sockets range from 5000-6000
    // e.g. incoming server connections
    this._id = options._id;
    nativeSocket = true;
  }
  usedIds.push(this._id);

  this._state = nativeSocket ? STATE.CONNECTED : STATE.DISCONNECTED;
  this._host = null;

  // these will be set once there is a connection
  this.readable = this.writable = false;

  this._subscription = DeviceEventEmitter.addListener(
    'tcp-' + this._id + '-event', this._onEvent.bind(this)
  );

  // ensure compatibility with node's EventEmitter
  if (!this.on) {
    this.on = this.addListener.bind(this);
  }

  if (nativeSocket === false) {
    Sockets.createSocket(this._id);
  }
}

inherits(TcpSocket, EventEmitter);

TcpSocket.prototype._debug = function() {
  if (__DEV__) {
    var args = [].slice.call(arguments);
    args.unshift('socket-' + this._id);
    console.log.apply(console, args);
  }
};

TcpSocket.prototype.connect = function(options: { port: number, host: ?string, localAddress: ?string, localPort: ?number, family: ?number }, callback: ?() => void) {
  if (this._state !== STATE.DISCONNECTED) {
    throw new Error('Socket is already bound');
  }

  if (typeof callback === 'function') {
    this.once('connect', callback);
  }

  var host = options.host || 'localhost';
  var port = options.port;
  var localAddress = options.localAddress;
  var localPort = options.localPort;

  if (localAddress && !ipRegex({exact: true}).test(localAddress)) {
    throw new TypeError('"localAddress" option must be a valid IP: ' + localAddress);
  }

  if (localPort && typeof localPort !== 'number') {
    throw new TypeError('"localPort" option should be a number: ' + localPort);
  }

  if (typeof port !== 'undefined') {
    if (typeof port !== 'number' && typeof port !== 'string') {
      throw new TypeError('"port" option should be a number or string: ' + port);
    }
    if (!isLegalPort(port)) {
      throw new RangeError('"port" option should be >= 0 and < 65536: ' + port);
    }
  }
  port |= port;

  this._state = STATE.CONNECTING;
  this._debug('connecting, host:', host, 'port:', port);

  Sockets.connect(this._id, host, Number(port), options);
};

// Check that the port number is not NaN when coerced to a number,
// is an integer and that it falls within the legal range of port numbers.
function isLegalPort(port: number) : boolean {
  if (typeof port === 'string' && port.trim() === '') {
    return false;
  }
  return +port === (port >>> 0) && port >= 0 && port <= 0xFFFF;
}

TcpSocket.prototype.setTimeout = function(msecs: number, callback: () => void) {
  var self = this;

  if (this._timeout) {
    clearTimeout(this._timeout);
    this._timeout = null;
  }

  if (msecs > 0) {
    if (callback) {
      this.once('timeout', callback);
    }

    var self = this;
    this._timeout = setTimeout(function() {
      self.emit('timeout');
      self._timeout = null;
      self.destroy();
    }, msecs);
  }
};

TcpSocket.prototype.setNoDelay = function(noDelay) {
  // nothing yet
};

TcpSocket.prototype.setEncoding = function(encoding) {
  // nothing yet
};

TcpSocket.prototype.setKeepAlive = function(enable, initialDelay) {
  // nothing yet
};

TcpSocket.prototype.pause = function() {
  // nothing yet
};

TcpSocket.prototype.resume = function() {
  // nothing yet
};

TcpSocket.prototype.ref = function() {
  // nothing yet
};

TcpSocket.prototype.unref = function() {
  // nothing yet
};

TcpSocket.prototype.address = function() {
  // nothing yet
};

TcpSocket.prototype.end = function(data, encoding) {
  if (this._destroyed) {
    return;
  }

  if (data) {
    this.write(data, encoding);
  }

  this._destroyed = true;
  this._debug('closing');
  this._subscription.remove();

  Sockets.end(this._id, this._debug.bind(this, 'closed'));
};

TcpSocket.prototype.destroy = function() {
  if (!this._destroyed) {
    this._destroyed = true;
    this._debug('destroying');
    this._subscription.remove();

    Sockets.destroy(this._id, this._debug.bind(this, 'closed'));
  }
};

TcpSocket.prototype._onEvent = function(info: { event: string, data: ?any }) {
  this._debug('received', info.event);

  if (info.event === 'connect') {
    this.writable = this.readable = true;
    this._state = STATE.CONNECTED;
  } else if (info.event === 'data') {
    if (this._timeout) {
      clearTimeout(this._timeout);
      this._timeout = null;
    }

    // from base64 string
    info.data = typeof Buffer === 'undefined'
      ? base64.toByteArray(info.data)
      : new global.Buffer(info.data, 'base64');
  } else if (info.event === 'close') {
    this._state = STATE.DISCONNECTED;
  }

  this.emit(info.event, info.data);
};

TcpSocket.prototype.write = function(buffer, encoding, callback) {
  var self = this;
  var encoded = false;

  if (this._state === STATE.DISCONNECTED) {
    throw new Error('Socket is not connected.');
  } else if (this._state === STATE.CONNECTING) {
    // we're ok, GCDAsyncSocket handles queueing internally
  }

  if (typeof encoding  === 'function') {
    callback = encoding;
    encoding = null;
  }
  callback = callback || noop;
  var str;
  if (typeof buffer === 'string') {
    console.warn('socket.WRITE(): encoding as base64');
    str = Base64Str.encode(buffer);
  } else if (typeof Buffer !== 'undefined' && global.Buffer.isBuffer(buffer)) {
    encoded = true;
    str = buffer.toString('base64');
  } else if (buffer instanceof Uint8Array || Array.isArray(buffer)) {
    encoded = true;
    str = base64.fromByteArray(buffer);
  } else {
    throw new Error('invalid message format');
  }

  Sockets.write(this._id, str, encoded, function(err) {
    if (self._timeout) {
      clearTimeout(self._timeout);
      self._timeout = null;
    }

    err = normalizeError(err);
    if (err) {
      self._debug('write failed', err);
      return callback(err);
    }

    callback();
  });
};

function normalizeError(err) {
  if (err) {
    if (typeof err === 'string') {
      err = new Error(err);
    }

    return err;
  }
}

module.exports = TcpSocket;
