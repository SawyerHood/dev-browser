// @ts-nocheck
import { ChannelOwner } from './channelOwner';

export class Electron extends ChannelOwner {
  static from(channel) {
    return channel?._object;
  }
}

export class ElectronApplication extends ChannelOwner {
  static from(channel) {
    return channel?._object;
  }
}
