// @ts-nocheck
import { ChannelOwner } from './channelOwner';

export class Tracing extends ChannelOwner {
  _tracesDir;

  static from(channel) {
    return channel?._object;
  }

  async start() {}

  async startChunk() {}

  async stop() {}

  async stopChunk() {}

  async group() {}

  async groupEnd() {}
}
