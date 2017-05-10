const crypto = require('crypto');

exports.md5 = function md5(str) {
  return crypto.createHash('md5').update(str, 'utf8').digest('hex');
};
exports.base64Sha1 = function base64Sha1(str, secret) {
  return crypto.createHmac('sha1', secret).update(str, 'utf8').digest().toString('base64');
};