'use strict';

const DataStore = require('./DataStore');
const File = require('../models/File');
const fs = require('fs');
const Configstore = require('configstore');
const pkg = require('../../package.json');
const Upyun = require('upyun');
const ffmpeg = require('fluent-ffmpeg');
const async = require('async');
const path = require('path');
const MASK = '0777';
const IGNORED_MKDIR_ERROR = 'EEXIST';
const FILE_DOESNT_EXIST = 'ENOENT';
const ERRORS = require('../constants').ERRORS;
const EVENTS = require('../constants').EVENTS;


/**
 * @fileOverview
 * Store using upyun store filesystem.
 *
 * @author cangbing.guo <cangbing.guo@upai.com>
 */

class FileUpyunStore extends DataStore {
    constructor(options) {
        super(options);

        this.directory = options.directory || options.path.replace(/^\//, '');

        this.extensions = ['creation', 'creation-defer-length'];
        this.configstore = new Configstore(`${pkg.name}-${pkg.version}`);
        this.upyun = new Upyun(
            options.bucket,
            options.username,
            options.password,
            'v0.api.upyun.com',
            {
                apiVersion: 'v2',
            }
        );
        this.headers = {};
        this.next_id = 0;
        this.file_length = 0;
        this.upyunUUID = null;
        this.upyunNextPart = 0;
        this.file_type = '';
        this._checkOrCreateDirectory();
    }

    /**
     *  Ensure the directory exists.
     */
    _checkOrCreateDirectory() {
        fs.mkdir(this.directory, MASK, (error) => {
            if (error && error.code !== IGNORED_MKDIR_ERROR) {
                throw error;
            }
        });
    }

    /**
     * Create an empty file.
     *
     * @param  {object} req http.incomingMessage
     * @param  {File} file
     * @return {Promise}
     */
    create(req) {
        return new Promise((resolve, reject) => {
            const upload_length = req.headers['upload-length'];
            const upload_defer_length = req.headers['upload-defer-length'];
            const upload_metadata = req.headers['upload-metadata'];
            const extensions = req.extensions || {};  // 保存额外的上传信息，上传完成可以用 get 的方式去获取做相应的数据。
            console.log(extensions);
            this.file_type = path.extname(new Buffer(upload_metadata.split(' ')[1], 'base64').toString('ascii'));

            if (upload_length === undefined && upload_defer_length === undefined) {
                return reject(ERRORS.INVALID_LENGTH);
            }

            let file_id;
            try {
                file_id = this.generateFileName(req);
            }
            catch (generateError) {
                console.warn('[FileStore] create: check your namingFunction. Error', generateError);
                return reject(ERRORS.FILE_WRITE_ERROR);
            }
            const file = new File(file_id, upload_length, upload_defer_length, upload_metadata, extensions);

            return fs.open(`${this.directory}/${file.id}`, 'w', (err, fd) => {
                if (err) {
                    console.warn('[FileStore] create: Error', err);
                    return reject(err);
                }

                this.configstore.set(file.id, file);
                this.file_length = file.upload_length;
                return fs.close(fd, (exception) => {
                    if (exception) {
                        console.warn('[FileStore] create: Error', exception);
                        return reject(exception);
                    }
                    let type = this.file_type;
                    type = type.substr(1, type.length);
                    type = type.toLowerCase();
                    const initOptions = {
                        'X-Upyun-Multi-Stage': 'initiate',
                        'X-Upyun-Multi-Length': file.upload_length,
                    };
                    return this.upyun.putFile(file.extensions.remote_dir, `${this.directory}/${file.id}`, type, true, initOptions, (error, res) => {
                        if (error) {
                            return reject(error);
                        }
                        this.next_id = 0;
                        if (Number(res.statusCode) !== 204) {
                            return reject(ERRORS.UPYUN_WRITE_ERROR);
                        }

                        this.headers = res.headers;
                        if (res.headers['x-upyun-multi-uuid']) {
                            this.upyunUUID = res.headers['x-upyun-multi-uuid'];
                            this.configstore.set(`upyun-uuid:${file.id}`, res.headers['x-upyun-multi-uuid']);
                        }
                        if (res.headers['x-upyun-next-part-size']) {
                            this.upyunNextPart = res.headers['x-upyun-next-part-size'];
                        }

                        this.emit(EVENTS.EVENT_FILE_CREATED, { file });
                        return resolve(file);
                    });

                });
            });
        });
    }

    /**
     * Write to the file, starting at the provided offset
     *
     * @param  {object} req http.incomingMessage
     * @param  {string} file_id   Name of file
     * @param  {integer} offset     starting offset
     * @return {Promise}
     */
    write(req, file_id, offset) {
        return new Promise((resolve, reject) => {
            const file_path = `${this.directory}/${file_id}`;
            const options = {
                flags: 'r+',
                start: offset,
            };

            const stream = fs.createWriteStream(file_path, options);

            let new_offset = 0;
            const chunk = [];
            req.on('data', (buffer) => {
                chunk.push(buffer);
                new_offset += buffer.length;
            });

            req.on('end', () => {
                console.info(`[FileStore] write: ${new_offset} bytes written to ${file_path}`);
                offset += new_offset;
                console.info(`[FileStore] write: File is now ${offset} bytes`);
                const opts = {
                    'X-Upyun-Multi-Stage': 'upload',
                    'X-Upyun-Part-ID': String(this.next_id),
                    'X-Upyun-Multi-Length': this.upyunNextPart,
                };
                const config = this.configstore.get(file_id);
                this.upyunUUID = this.configstore.get(`upyun-uuid:${file_id}`);
                if (this.upyunUUID) {
                    opts['X-Upyun-Multi-UUID'] = this.upyunUUID;
                }
                if (config && parseInt(config.upload_length, 10) === offset) {
                    this.emit(EVENTS.EVENT_UPLOAD_COMPLETE, { file: config });
                }
                const totalLength = chunk.map((item) => item.length).reduce((acc, val) => {
                    return acc + val;
                }, 0);
                const block = Buffer.concat(chunk, totalLength);
                console.log('this next------------->id', this.next_id);
                async.waterfall([
                    (callback) => {
                        if (this.next_id == 0) return ffmpeg.ffprobe(file_path, callback);
                        callback(null, null);
                    }
                ], (error, metadata) => {
                    if (error) return reject(error);
                    if (metadata) {
                        const videoDuration = Math.floor(metadata.format.duration);
                        if ((videoDuration / 60) > 15) {
                            return reject(ERRORS.VIDEO_DURATION_ERROR);
                        }
                    }
                    return this.upyun.putFile(config.extensions.remote_dir, block, null, true, opts, (error, res) => {
                        if (error) {
                            return reject(error);
                        }
                        if (Number(res.statusCode) !== 204) {
                            return reject(ERRORS.UPYUN_WRITE_ERROR);
                        }
                        console.log(res);
                        this.headers = res.headers;
                        if (Number(res.headers['x-upyun-next-part-id']) !== -1) {
                            this.next_id = res.headers['x-upyun-next-part-id'];
                            return resolve(offset);
                        }

                        this.upyun.putFile(config.extensions.remote_dir, block, null, true, {
                            'X-Upyun-Multi-Stage': 'complete',
                            'X-Upyun-Multi-UUID': this.upyunUUID
                        }, (err, response) => {
                            if (err) {
                                return reject(err);
                            }
                            if (Number(response.statusCode) !== 204 && Number(response.statusCode) !== 201) {
                                return reject(ERRORS.UPYUN_WRITE_ERROR);
                            }
                            return resolve(offset);
                        });
                    });
                });
            });

            stream.on('error', (e) => {
                console.warn('[FileStore] write: Error', e);
                reject(ERRORS.FILE_WRITE_ERROR);
            });

            return req.pipe(stream);
        });
    }

    /**
     * Return file stats, if they exits
     *
     * @param  {string} file_id name of the file
     * @return {object}           fs stats
     */
    getOffset(file_id) {
        const config = this.configstore.get(file_id);
        return new Promise((resolve, reject) => {
            const file_path = `${this.directory}/${file_id}`;
            fs.stat(file_path, (error, stats) => {
                if (error && error.code === FILE_DOESNT_EXIST && config) {
                    console.warn(`[FileStore] getOffset: No file found at ${file_path} but db record exists`, config);
                    return reject(ERRORS.FILE_NO_LONGER_EXISTS);
                }

                if (error && error.code === FILE_DOESNT_EXIST) {
                    console.warn(`[FileStore] getOffset: No file found at ${file_path}`);
                    return reject(ERRORS.FILE_NOT_FOUND);
                }

                if (error) {
                    return reject(error);
                }

                if (stats.isDirectory()) {
                    console.warn(`[FileStore] getOffset: ${file_path} is a directory`);
                    return reject(ERRORS.FILE_NOT_FOUND);
                }

                const data = Object.assign(stats, config);
                return resolve(data);
            });
        });
    }
}

module.exports = FileUpyunStore;
