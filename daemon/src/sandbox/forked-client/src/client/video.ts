// @ts-nocheck
import { EventEmitter } from './eventEmitter';

export class Video extends EventEmitter {
  constructor(page, connection, artifact) {
    super(page._platform);
    this._page = page;
    this._connection = connection;
    this._artifact = artifact;
  }

  async start() {
    throw new Error('Video capture is not available in the QuickJS sandbox');
  }

  async stop() {}

  async path() {
    throw new Error('Video capture is not available in the QuickJS sandbox');
  }

  async saveAs() {
    throw new Error('Video capture is not available in the QuickJS sandbox');
  }

  async delete() {
    await this._artifact?.delete?.();
  }
}
