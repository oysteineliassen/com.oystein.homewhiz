'use strict';

const Homey = require('homey');

class HomeWhizApp extends Homey.App {

  async onInit() {
    this.log('HomeWhiz app started');
  }

}

module.exports = HomeWhizApp;
