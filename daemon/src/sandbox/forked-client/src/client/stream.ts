// @ts-nocheck
import { ChannelOwner } from './channelOwner';

export class Stream extends ChannelOwner {
  static from(channel) {
    return channel?._object;
  }

  stream() {
    throw new Error('Readable streams are not available in the QuickJS sandbox');
  }
}
