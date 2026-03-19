// @ts-nocheck
import { ChannelOwner } from './channelOwner';

function unsupported() {
  throw new Error('LocalUtils is not available in the QuickJS sandbox');
}

export class LocalUtils extends ChannelOwner {
  devices = {};

  static from(channel) {
    return channel?._object;
  }

  async connect() {
    unsupported();
  }

  async addStackToTracingNoReply() {}

  async zip() {
    unsupported();
  }

  async harOpen() {
    unsupported();
  }

  async harLookup() {
    unsupported();
  }

  async harClose() {
    unsupported();
  }

  async harUnzip() {
    unsupported();
  }
}
