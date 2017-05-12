const _ = require('lodash');
const utils = require('./utils');
const request = require('request');

class Upyun {
    constructor(options) {
        if (!options) {
          throw new Error('Upyun config not set');
        }
        this.config = options;
    }

    putFile(dest,  data, headers, callback) {
         const upyunConfig = this.config;
         const uri = `/${upyunConfig.bucket}${dest}`;
         const method = 'PUT';
         const date = (new Date()).toGMTString();
         const signature = utils.base64Sha1(`${method}&${uri}&${date}`, utils.md5(upyunConfig.password));
         request({
             url: `http://v0.api.upyun.com${uri}`,
             method,
             headers: _.assign(headers, {
                 Authorization: `UPYUN ${upyunConfig.username}:${signature}`,
                 Date: date,
             }),
             body: data
        }, callback);
    }
}
module.exports = Upyun;