'use strict';

class ByteChannel {
  constructor(socket, authorize = () => true) {
    this.socket = socket;
    this.authorize = authorize;
    this.chunks = [];
    this.length = 0;
    this.waiters = [];
    this.closed = false;
    this.forward = null;
    this._onData = data => this._push(Buffer.isBuffer(data) ? data : Buffer.from(data));
    this._onMessage = (data) => this._push(Buffer.isBuffer(data) ? data : Buffer.from(data));
    this._onClose = () => this._close(new Error('Console stream closed'));
    this._onError = err => this._close(err || new Error('Console stream failed'));
    this.isWebSocket = typeof socket.send === 'function' && typeof socket.readyState === 'number';
    if (this.isWebSocket) {
      socket.on('message', this._onMessage);
      socket.on('close', this._onClose);
      socket.on('error', this._onError);
    } else {
      socket.on('data', this._onData);
      socket.on('close', this._onClose);
      socket.on('end', this._onClose);
      socket.on('error', this._onError);
    }
  }

  _push(data) {
    if (!data.length || !this._allowed()) return;
    if (this.forward) return this.forward(data);
    this.chunks.push(data);
    this.length += data.length;
    const waiters = this.waiters.splice(0);
    waiters.forEach(waiter => waiter.resolve());
  }

  _close(error) {
    if (this.closed) return;
    this.closed = true;
    this.chunks = [];
    this.length = 0;
    const waiters = this.waiters.splice(0);
    waiters.forEach(waiter => waiter.reject(error));
  }

  async _wait(timeoutMs) {
    // readExact calls this when buffered bytes are insufficient. Returning for
    // a partial frame spins microtasks until the read deadline, starving I/O.
    if (this.closed) return;
    await new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      this.waiters.push(waiter);
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error('Console stream timed out'));
      }, timeoutMs);
      waiter.resolve = () => { clearTimeout(timer); resolve(); };
      waiter.reject = err => { clearTimeout(timer); reject(err); };
    });
  }

  async readExact(size, timeoutMs = 15_000) {
    if (!Number.isInteger(size) || size < 0 || size > 1024 * 1024) throw new Error('Invalid console read size');
    if (!this._allowed()) throw new Error('Console access denied');
    const deadline = Date.now() + timeoutMs;
    while (this.length < size) {
      if (this.closed) throw new Error('Console stream closed');
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('Console stream timed out');
      await this._wait(remaining);
      if (!this._allowed()) throw new Error('Console access denied');
    }
    const output = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const chunk = this.chunks[0];
      const take = Math.min(chunk.length, size - offset);
      chunk.copy(output, offset, 0, take);
      offset += take;
      this.length -= take;
      if (take === chunk.length) this.chunks.shift();
      else this.chunks[0] = chunk.subarray(take);
    }
    return output;
  }

  write(data) {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (!this._allowed()) return Promise.reject(new Error('Console access denied'));
    if (this.isWebSocket) {
      return new Promise((resolve, reject) => {
        this.socket.send(buffer, { binary: true }, err => err ? reject(err) : resolve());
      });
    }
    return new Promise((resolve, reject) => {
      this.socket.write(buffer, err => err ? reject(err) : resolve());
    });
  }

  startForward(callback) {
    if (!this._allowed()) return;
    if (this.forward) throw new Error('Console stream is already forwarding');
    this.forward = callback;
    const pending = this.chunks.splice(0);
    this.length = 0;
    for (const data of pending) {
      if (!this._allowed()) break;
      callback(data);
    }
  }

  _allowed() {
    if (this.closed) return false;
    try { if (this.authorize()) return true; } catch {}
    this.destroy();
    return false;
  }

  destroy() {
    this._close(new Error('Console stream closed'));
    if (this.isWebSocket) {
      this.socket.off('message', this._onMessage);
      try { this.socket.close(); } catch {}
    } else {
      this.socket.off('data', this._onData);
      try { this.socket.destroy(); } catch {}
    }
  }
}

module.exports = ByteChannel;
