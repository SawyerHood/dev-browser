// @ts-nocheck
import { ChannelOwner } from './channelOwner';

export class Artifact extends ChannelOwner {
  static from(channel) {
    return channel?._object;
  }

  async pathAfterFinished() {
    throw new Error('Artifacts are not available in the QuickJS sandbox');
  }

  async saveAs() {
    throw new Error('Artifacts are not available in the QuickJS sandbox');
  }

  async failure() {
    return null;
  }

  async createReadStream() {
    throw new Error('Artifacts are not available in the QuickJS sandbox');
  }

  async readIntoBuffer() {
    throw new Error('Artifacts are not available in the QuickJS sandbox');
  }

  async cancel() {
    await this._channel.cancel?.();
  }

  async delete() {
    await this._channel.delete?.();
  }
}
