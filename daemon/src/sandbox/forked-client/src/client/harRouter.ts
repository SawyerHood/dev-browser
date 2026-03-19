// @ts-nocheck
function unsupported() {
  throw new Error('HAR routing is not available in the QuickJS sandbox');
}

export class HarRouter {
  static async create() {
    return new HarRouter();
  }

  async addContextRoute() {
    unsupported();
  }

  async addPageRoute() {
    unsupported();
  }

  async dispose() {}
}
