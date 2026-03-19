// @ts-nocheck
export class Screencast {
  constructor(page) {
    this._page = page;
  }

  async start() {
    throw new Error('Screencast is not available in the QuickJS sandbox');
  }

  async stop() {}
}
