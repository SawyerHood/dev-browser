// @ts-nocheck
import { ChannelOwner } from './channelOwner';

export class Android extends ChannelOwner {
  static from(channel) {
    return channel?._object;
  }
}

export class AndroidDevice extends ChannelOwner {
  static from(channel) {
    return channel?._object;
  }
}

export class AndroidSocket extends ChannelOwner {
  static from(channel) {
    return channel?._object;
  }
}

export class AndroidInput {}

export class AndroidWebView extends ChannelOwner {
  static from(channel) {
    return channel?._object;
  }
}
