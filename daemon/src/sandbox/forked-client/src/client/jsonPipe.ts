// @ts-nocheck
import { ChannelOwner } from './channelOwner';

export class JsonPipe extends ChannelOwner {
  static from(channel) {
    return channel?._object;
  }
}
