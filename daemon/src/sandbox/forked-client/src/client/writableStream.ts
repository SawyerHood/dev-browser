// @ts-nocheck
import { ChannelOwner } from './channelOwner';

export class WritableStream extends ChannelOwner {
  static from(channel) {
    return channel?._object;
  }

  stream() {
    throw new Error('Writable streams are not available in the QuickJS sandbox');
  }
}
