'use strict';

const BaseHandler = require('./BaseHandler');
const ERRORS = require('../constants').ERRORS;
const EVENT_ENDPOINT_CREATED = require('../constants').EVENT_ENDPOINT_CREATED;

class GetHandler extends BaseHandler {
    /**
     * Create a file in the DataStore.
     *
     * @param  {object} req http.incomingMessage
     * @param  {object} res http.ServerResponse
     * @return {function}
     */
    
    send(req, res) {
        const file_id = this.getFileIdFromRequest(req);
        if (file_id === false) {
            return super.send(res, ERRORS.FILE_NOT_FOUND.status_code, {}, ERRORS.FILE_NOT_FOUND.body);
        }

        // The request MUST include a Upload-Offset header
        let offset = req.headers['upload-offset'];
        if (offset === undefined) {
            return super.send(res, ERRORS.MISSING_OFFSET.status_code, {}, ERRORS.MISSING_OFFSET.body);
        }

        // The request MUST include a Content-Type header
        const content_type = req.headers['content-type'];
        if (content_type === undefined) {
            return super.send(res, ERRORS.INVALID_CONTENT_TYPE.status_code, {}, ERRORS.INVALID_CONTENT_TYPE.body);
        }
        return this.store.getOffset(file_id)
            .then((data) => {
                return super.send(res, 200, data);
            })
            .catch((error) => {
                console.warn('[GetHandler]', error);
                const status_code = error.status_code || ERRORS.UNKNOWN_ERROR.status_code;
                const body = error.body || `${ERRORS.UNKNOWN_ERROR.body}${error.message || ''}\n`;
                return super.send(res, status_code, {}, body);
            });
    }
}

module.exports = GetHandler;
