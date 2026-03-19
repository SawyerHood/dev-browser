// @ts-nocheck
import { ChannelOwner } from './channelOwner';

function unsupported() {
  throw new Error('APIRequest is not available in the QuickJS sandbox');
}

export class APIRequestContext extends ChannelOwner {
  static from(channel) {
    return channel?._object;
  }

  async storageState() {
    return { cookies: [], origins: [] };
  }

  async dispose() {
    await this._channel.dispose?.({});
  }
}

export class APIRequest {
  constructor(playwright) {
    this._playwright = playwright;
  }

  async newContext() {
    unsupported();
  }
}

export class APIResponse {
  async body() {
    unsupported();
  }
}
