'use strict';

const restify = require('restify'),
  mongoose = require('mongoose'),
  fs = require('fs'),
  GeoJSON = require('geojson'),
  _ = require('lodash'),
  models = require('../models'),
  csvstringify = require('csv-stringify'),
  csvtransform = require('stream-transform'),
  moment = require('moment'),
  jsonstringify = require('stringify-stream'),
  utils = require('../utils'),
  decodeHandlers = require('../decoding'),
  sketches = require('../sketches'),
  requestUtils = require('../requestUtils');

const { config, Honeybadger } = utils;
const { Measurement, Box, Sensor } = models;

/**
 * @api {put} /boxes/:senseBoxId Update a senseBox: Image and sensor names
 * @apiDescription Modify the specified senseBox.
 *
 * @apiUse CommonBoxJSONBody
 * @apiUse SensorBody
 * @apiUse MqttBody
 *
 * @apiParam (RequestBody) {String} description the updated description of this senseBox.
 * @apiParam (RequestBody) {String} image the updated image of this senseBox encoded as base64 data uri.
 * @apiParamExample {json} Request-Example:
 * {
 *  "_id": "56e741ff933e450c0fe2f705",
 *  "name": "my senseBox",
 *  "description": "this is just a description",
 *  "weblink": "https://opensensemap.org/explore/561ce8acb3de1fe005d3d7bf",
 *  "grouptag": "senseBoxes99",
 *  "exposure": "indoor",
 *  "sensors": [
 *    {
 *      "_id": "56e741ff933e450c0fe2f707",
 *      "title": "UV-Intensität",
 *      "unit": "μW/cm²",
 *      "sensorType": "VEML6070",
 *      "icon": "osem-sprinkles"
 *    }
 *  ],
 *  "loc": {
 *    "lng": 8.6956,
 *    "lat": 50.0430
 *  },
 *  "image": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAMAAAAoLQ9TAAAAIVBMVEUAAABKrkMGteh0wW5Ixu931vKy3bO46fj/7hr/+J36/vyFw5EiAAAAAXRSTlMAQObYZgAAAF5JREFUeAFdjdECgzAIA1kIUvP/HzyhdrPe210L2GLYzhjj7VvRefmpn1MKFbdHUOzA9qRQEhIw3xMzEVeJDqkOrC9IJqWE7hFDLZ0Q6+zh7odsoU/j9qeDPXDf/cEX1xsDKIqAkK8AAAAASUVORK5CYII=",
 *  "mqtt": {
 *    "url": "some url",
 *    "topic": "some topic",
 *    "messageFormat": "json",
 *    "decodeOptions": "{\"jsonPath\":\"$.bla\"}"
 *  }
 * }
 * @apiVersion 0.0.1
 * @apiGroup Boxes
 * @apiName updateBox
 * @apiUse AuthorizationRequiredError
 * @apiUse BoxIdParam
 *
 */
const updateBox = function updateBox (req, res, next) {
  /*
  var newBoxData = {
    _id
    name
    sensors
    description
    weblink
    grouptag
    exposure
    loc
    image
  };
  */

  const qrys = [];
  Box.findById(req.boxId).then(function (box) {
    if (typeof req.params.name !== 'undefined' && req.params.name !== '') {
      if (box.name !== req.params.name) {
        qrys.push(box.set({ name: req.params.name }));
      }
    }
    if (typeof req.params.exposure !== 'undefined' && req.params.exposure !== '') {
      if (box.exposure !== req.params.exposure) {
        qrys.push(box.set({ exposure: req.params.exposure }));
      }
    }
    if (typeof req.params.grouptag !== 'undefined' && req.params.grouptag !== '') {
      if (box.grouptag !== req.params.grouptag) {
        qrys.push(box.set({ grouptag: req.params.grouptag }));
      }
    }
    if (typeof req.params.weblink !== 'undefined' && req.params.weblink !== '') {
      if (box.weblink !== req.params.weblink) {
        qrys.push(box.set({ weblink: req.params.weblink }));
      }
    }
    if (typeof req.params.description !== 'undefined' && req.params.description !== '') {
      if (box.description !== req.params.description) {
        qrys.push(box.set({ description: req.params.description }));
      }
    }
    if (typeof req.params.loc !== 'undefined' && req.params.loc !== '') {
      if (String(box.loc[0].geometry.coordinates[0]) !== req.params.loc.lng || String(box.loc[0].geometry.coordinates[1]) !== req.params.loc.lat) {
        box.loc[0].geometry.coordinates = [req.params.loc.lng, req.params.loc.lat];
      }
    }
    if (typeof req.params.image !== 'undefined' && req.params.image !== '') {
      const data = req.params.image.toString();
      const imageBuffer = requestUtils.decodeBase64Image(data);
      const extension = (imageBuffer.type === 'image/jpeg') ? '.jpg' : '.png';
      try {
        fs.writeFileSync(`${config.imageFolder}${req.boxId}${extension}`, imageBuffer.data);
        qrys.push(box.set({ image: `${req.boxId + extension}?${new Date().getTime()}` }));
      } catch (e) {
        return next(new restify.InternalServerError(JSON.stringify(e.message)));
      }
    }
    if (req.params.mqtt === null) {
      qrys.push(box.set('mqtt', {}));
    } else if (typeof req.params.mqtt !== 'undefined' && typeof req.params.mqtt.url !== 'undefined' && typeof req.params.mqtt.topic !== 'undefined') {
      qrys.push(box.set({ 'mqtt': req.params.mqtt }));
    }
    if (typeof req.params.sensors !== 'undefined' && req.params.sensors.length > 0) {
      req.params.sensors.forEach(function (updatedsensor) {
        if (updatedsensor.deleted) {
          qrys.push(Measurement.find({ sensor_id: updatedsensor._id }).remove());
          qrys.push(Box.update({ 'sensors._id': mongoose.Types.ObjectId(updatedsensor._id) },
            { $pull: { 'sensors': { _id: mongoose.Types.ObjectId(updatedsensor._id) } }
            }));
        } else if (updatedsensor.edited && updatedsensor.new) {
          const newsensor = new Sensor({
            'title': updatedsensor.title,
            'unit': updatedsensor.unit,
            'sensorType': updatedsensor.sensorType,
            'icon': updatedsensor.icon
          });
          box.sensors.push(newsensor);
        } else if (updatedsensor.edited && !updatedsensor.deleted) {
          qrys.push(Box.update({ 'sensors._id': mongoose.Types.ObjectId(updatedsensor._id) }, { '$set': {
            'sensors.$.title': updatedsensor.title,
            'sensors.$.unit': updatedsensor.unit,
            'sensors.$.sensorType': updatedsensor.sensorType,
            'sensors.$.icon': updatedsensor.icon
          } }));
        }
      });
    }
    qrys.push(box.save());

    Promise.all(qrys).then(function () {
      sketches.generateSketch(box);
      res.send(200, box);
    })
    .catch(function (err) {
      Honeybadger.notify(err);

      return next(new restify.InternalServerError(JSON.stringify(err.message)));
    });
  })
  .catch(function (err) {
    Honeybadger.notify(err);

    return next(new restify.InternalServerError(JSON.stringify(err.message)));
  });
};

/**
 * @api {get} /boxes/:senseBoxId/sensors Get latest measurements of a senseBox
 * @apiDescription Get the latest measurements of all sensors of the specified senseBox.
 * @apiVersion 0.0.1
 * @apiGroup Measurements
 * @apiName getMeasurements
 * @apiUse BoxIdParam
 */
const getMeasurements = function getMeasurements (req, res, next) {
  Box.findAndPopulateBoxById(req.boxId, { onlyLastMeasurements: true })
    .then(function (box) {
      if (box) {
        res.send(box);
      } else {
        return next(new restify.NotFoundError('No senseBox found'));
      }
    })
    .catch(function (error) {
      const e = error.errors;
      Honeybadger.notify(error);

      return next(new restify.InternalServerError(e));
    });
};

/**
 * @api {get} /boxes/:senseBoxId/data/:sensorId?from-date=fromDate&to-datetoDate&download=true&format=json Get the 10000 latest measurements for a sensor
 * @apiDescription Get up to 10000 measurements from a sensor for a specific time frame, parameters `from-date` and `to-date` are optional. If not set, the last 48 hours are used. The maximum time frame is 1 month. If `download=true` `Content-disposition` headers will be set. Allows for JSON or CSV format.
 * @apiVersion 0.0.1
 * @apiGroup Measurements
 * @apiName getData
 * @apiUse BoxIdParam
 * @apiUse SensorIdParam
 * @apiParam {ISO8601Date} [from-date] Beginning date of measurement data (default: 48 hours ago from now)
 * @apiParam {ISO8601Date} [to-date] End date of measurement data (default: now)
 * @apiParam {String="json","csv"} [format=json] Can be 'json' (default) or 'csv' (default: json)
 * @apiParam {Boolean="true","false"} [download] if specified, the api will set the `content-disposition` header thus forcing browsers to download instead of displaying. Is always true for format csv.
 * @apiUse SeparatorParam
 */
const getData = function getData (req, res, next) {
  // default to now
  const toDate = utils.parseTimeParameter(req, next, 'to-date', moment());
  if (!moment.isMoment(toDate)) {
    return next(toDate);
  }

  // default to 48 hours earlier from to-date
  const fromDate = utils.parseTimeParameter(req, next, 'from-date', toDate.clone().subtract(48, 'hours'));
  if (!moment.isMoment(fromDate)) {
    return next(fromDate);
  }

  // validate time parameters
  const timesValid = utils.validateTimeParameters(toDate, fromDate);
  if (typeof timesValid !== 'undefined') {
    return next(timesValid);
  }

  const format = requestUtils.getRequestedFormat(req, ['json', 'csv'], 'json');
  if (typeof format === 'undefined') {
    return next(new restify.InvalidArgumentError(`Invalid format: ${req.params['format']}`));
  }

  let stringifier;

  const csvTransformer = csvtransform(function (data) {
    data.createdAt = new Date(data.createdAt).toISOString();

    return data;
  });
  csvTransformer.on('error', (err) => {
    console.log(err.message);
    Honeybadger.notify(err);

    return next(new restify.InternalServerError(err.message));
  });

  if (format === 'csv') {
    res.header('Content-Type', 'text/csv');
    const delim = requestUtils.getDelimiter(req);
    stringifier = csvstringify({ columns: ['createdAt', 'value'], header: 1, delimiter: delim });
  } else if (format === 'json') {
    res.header('Content-Type', 'application/json; charset=utf-8');
    stringifier = jsonstringify({ open: '[', close: ']' });
  }

  stringifier.on('error', (err) => {
    console.log(err.message);
    Honeybadger.notify(err);

    return next(new restify.InternalServerError(err.message));
  });

  // offer download to browser
  if (format === 'csv' || (typeof req.params['download'] !== 'undefined' && req.params['download'] === 'true')) {
    res.header('Content-Disposition', `attachment; filename=${req.params.sensorId}.${format}`);
  }

  // finally execute the query
  const queryLimit = 10000;

  const qry = {
    sensor_id: req.params.sensorId,
    createdAt: { $gte: fromDate.toDate(), $lte: toDate.toDate() }
  };

  Measurement.find(qry, { 'createdAt': 1, 'value': 1, '_id': 0 }) // do not send _id column
    .limit(queryLimit)
    .lean()
    .cursor({ batchSize: 500 })
    .pipe(csvTransformer)
    .pipe(stringifier)
    .pipe(res);
};

/**
 * @api {get,post} /boxes/data?boxid=:senseBoxIds&from-date=:fromDate&to-date:toDate&phenomenon=:phenomenon Get latest measurements for a phenomenon as CSV
 * @apiDescription Download data of a given phenomenon from multiple selected senseBoxes as CSV
 * @apiVersion 0.1.0
 * @apiGroup Measurements
 * @apiName getDataMulti
 * @apiParam {String} senseBoxIds Comma separated list of senseBox IDs.
 * @apiParam {String} phenomenon the name of the phenomenon you want to download the data for.
 * @apiParam {ISO8601Date} [from-date] Beginning date of measurement data (default: 15 days ago from now)
 * @apiParam {ISO8601Date} [to-date] End date of measurement data (default: now)
 * @apiUse SeparatorParam
 * @apiUse BBoxParam
 * @apiParam {String} [columns=createdAt,value,lat,lng] (optional) Comma separated list of columns to export. If omitted, columns createdAt, value, lat, lng are returned. Possible allowed values are createdAt, value, lat, lng, unit, boxId, sensorId, phenomenon, sensorType, boxName, exposure. The columns in the csv are like the order supplied in this parameter
 * @apiParam {String="indoor","outdoor"} [exposure] (optional) only return sensors of boxes with the specified exposure. Can be indoor or outdoor
 */
const GET_DATA_MULTI_DEFAULT_COLUMNS = ['createdAt', 'value', 'lat', 'lng'];
const GET_DATA_MULTI_ALLOWED_COLUMNS = ['createdAt', 'value', 'lat', 'lng', 'unit', 'boxId', 'sensorId', 'phenomenon', 'sensorType', 'boxName', 'exposure'];

const getDataMulti = function getDataMulti (req, res, next) {
  // default to now
  const toDate = utils.parseTimeParameter(req, next, 'to-date', moment().utc());
  if (!moment.isMoment(toDate)) {
    return next(toDate);
  }

  // default to 15 days earlier
  const fromDate = utils.parseTimeParameter(req, next, 'from-date', toDate.clone().subtract(15, 'days'));
  if (!moment.isMoment(fromDate)) {
    return next(fromDate);
  }

  // validate time parameters
  const timesValid = utils.validateTimeParameters(toDate, fromDate);
  if (typeof timesValid !== 'undefined') {
    return next(timesValid);
  }

  // column parameter
  const delim = requestUtils.getDelimiter(req);
  let columns = GET_DATA_MULTI_DEFAULT_COLUMNS;
  const columnsParam = req.params['columns'];
  if (typeof columnsParam !== 'undefined' && columnsParam.trim() !== '') {
    columns = columnsParam.split(',');
    if (columns.some(c => !GET_DATA_MULTI_ALLOWED_COLUMNS.includes(c))) {
      return next(new restify.UnprocessableEntityError('illegal columns parameter'));
    }
  }

  // build query
  const queryParams = {};
  let phenomenon = req.params['phenomenon'];
  if (phenomenon && phenomenon.trim() !== '') {
    phenomenon = phenomenon.trim();
    queryParams['sensors.title'] = phenomenon;
  } else {
    return next(new restify.BadRequestError('invalid phenomenon parameter'));
  }

  if (req.boxId && req.bbox) {
    return next(new restify.BadRequestError('please specify only boxId or bbox'));
  } else if (req.boxId || req.bbox) {
    if (req.boxId) {
      const boxIds = req.boxId.split(',');
      queryParams['_id'] = {
        '$in': boxIds
      };
    } else if (req.bbox) {
      // transform bounds to polygon
      queryParams['loc.geometry'] = {
        '$geoWithin': {
          '$geometry':
          {
            type: 'Polygon',
            coordinates: [ [
              [req.bbox[0], req.bbox[1]],
              [req.bbox[0], req.bbox[3]],
              [req.bbox[2], req.bbox[3]],
              [req.bbox[2], req.bbox[1]],
              [req.bbox[0], req.bbox[1]]
            ] ]
          }
        }
      };
    }
  } else {
    return next(new restify.BadRequestError('please specify either boxId or bbox'));
  }

  // exposure parameter
  if (req.params['exposure']) {
    const exposureParam = req.params['exposure'].trim();
    if (exposureParam === 'indoor' || exposureParam === 'outdoor') {
      queryParams['exposure'] = exposureParam;
    } else {
      return next(new restify.UnprocessableEntityError('exposure column should be indoor or outdoor'));
    }
  }

  Box.find(queryParams)
    .lean()
    .exec()
    .then(function (boxData) {
      const sensors = Object.create(null);

      for (let i = 0, len = boxData.length; i < len; i++) {
        for (let j = 0, sensorslen = boxData[i].sensors.length; j < sensorslen; j++) {
          if (boxData[i].sensors[j].title === phenomenon) {
            const sensor = boxData[i].sensors[j];

            sensor.lat = boxData[i].loc[0].geometry.coordinates[0];
            sensor.lng = boxData[i].loc[0].geometry.coordinates[1];
            sensor.boxId = boxData[i]._id.toString();
            sensor.boxName = boxData[i].name;
            sensor.exposure = boxData[i].exposure;
            sensor.sensorId = sensor._id.toString();
            sensor.phenomenon = sensor.title;

            sensors[boxData[i].sensors[j]['_id']] = sensor;
          }
        }
      }

      const stringifier = csvstringify({ columns: columns, header: 1, delimiter: delim });
      const transformer = csvtransform(function (data) {
        data.createdAt = utils.parseTimestamp(data.createdAt).toISOString();

        for (const col of columns) {
          if (!data[col]) {
            data[col] = sensors[data.sensor_id][col];
          }
        }

        return data;
      });

      transformer.on('error', function (err) {
        console.log(err.message);
        Honeybadger.notify(err);

        return next(new restify.InternalServerError(JSON.stringify(err.message)));
      });

      res.header('Content-Type', 'text/csv');
      Measurement.find({
        'sensor_id': {
          '$in': Object.keys(sensors)
        },
        createdAt: {
          '$gt': fromDate.toDate(),
          '$lt': toDate.toDate()
        }
      }, { 'createdAt': 1, 'value': 1, '_id': 0, 'sensor_id': 1 })
        .lean()
        .cursor({ batchSize: 500 })
        .pipe(transformer)
        .pipe(stringifier)
        .pipe(res);
    })
    .catch(function (err) {
      console.log(err);
      Honeybadger.notify(err);

      return next(new restify.InternalServerError(JSON.stringify(err.errors)));
    });
};

/**
 * @api {post} /boxes/:senseBoxId/:sensorId Post new measurement
 * @apiDescription Posts a new measurement to a specific sensor of a box.
 * @apiVersion 0.0.1
 * @apiGroup Measurements
 * @apiName postNewMeasurement
 * @apiUse BoxIdParam
 * @apiUse SensorIdParam
 * @apiParam (RequestBody) {String} value the measured value of the sensor. Also accepts JSON float numbers.
 * @apiParam (RequestBody) {ISO8601Date} [createdAt] the timestamp of the measurement. Should be parseable by JavaScript.
 */
const postNewMeasurement = function postNewMeasurement (req, res, next) {
  const jsonHandler = decodeHandlers.json;
  // decode the body..
  let measurements;
  try {
    measurements = jsonHandler.decodeMessage([{
      sensor_id: req.params.sensorId,
      value: req.params.value,
      createdAt: req.params.createdAt
    }]);
  } catch (err) {
    return next(new restify.UnprocessableEntityError(err.message));
  }
  Box.findOne({ _id: req.boxId })
    .then(function (box) {
      if (!box) {
        return next(new restify.NotFoundError('no senseBox found'));
      }

      return box.saveMeasurement(measurements[0]);
    })
    .then(function () {
      res.send(201, 'Measurement saved in box');
    })
    .catch(function (err) {
      console.log(err);
      Honeybadger.notify(err);

      return next(new restify.UnprocessableEntityError(`${err.message}. ${err}`));
    });
};

/**
 * @api {post} /boxes/:boxId/data Post multiple new measurements
 * @apiDescription Post multiple new measurements in multiple formats to a box. Allows the use of csv, json array and json object notation.
 *
 * **CSV:**<br/>
 * For data in csv format, first use `content-type: text/csv` as header, then submit multiple values as lines in `sensorId,value,[createdAt]` form.
 * Timestamp is optional. Do not submit a header.
 *
 * **JSON Array:**<br/>
 * You can submit your data as array. Your measurements should be objects with the keys `sensor`, `value` and optionally `createdAt`. Specify the header `content-type: application/json`.
 *
 * **JSON Object:**<br/>
 * The third form is to encode your measurements in an object. Here, the keys of the object are the sensorIds, the values of the object are either just the `value` of your measurement or an array of the form `[value, createdAt]`
 *
 * For all encodings, the maximum count of values in one request is 2500.
 *
 * @apiVersion 0.1.0
 * @apiGroup Measurements
 * @apiName postNewMeasurements
 * @apiUse BoxIdParam
 * @apiParamExample {application/json} JSON-Object:
 * {
 *   "sensorID": "value",
 *   "anotherSensorID": ["value", "createdAt as ISO8601-timestamp"],
 *   "sensorIDtheThird": ["value"]
 *   ...
 * }
 * @apiParamExample {application/json} JSON-Array:
 * [
 *   {"sensor":"sensorID", "value":"value"},
 *   {"sensor":"anotherSensorId", "value":"value", "createdAt": "ISO8601-timestamp"}
 *   ...
 * ]
 * @apiParamExample {text/csv} CSV:
 * sensorID,value
 * anotherSensorId,value,ISO8601-timestamp
 * sensorIDtheThird,value
 * ...
 */
const postNewMeasurements = function postNewMeasurements (req, res, next) {
  // when the body is an array, restify overwrites the req.params with the given array.
  // to get the boxId, try to extract it from the path
  const boxId = req.path().split('/')[2];
  const handler = decodeHandlers[req.contentType().toLowerCase()];
  if (handler) {
    // decode the body..
    let measurements;
    try {
      measurements = handler.decodeMessage(req.body);
    } catch (err) {
      return next(new restify.UnprocessableEntityError(err.message));
    }
    Box.findOne({ _id: boxId })
      .then(function (box) {
        if (!box) {
          return next(new restify.NotFoundError('no senseBox found'));
        }

        return box.saveMeasurementsArray(measurements);
      })
      .then(function () {
        res.send(201, 'Measurements saved in box');
      })
      .catch(function (err) {
        console.log(err);
        Honeybadger.notify(err);

        return next(new restify.UnprocessableEntityError(`${err.message}. ${err}`));
      });
  } else {
    return next(new restify.UnsupportedMediaTypeError('Unsupported content-type.'));
  }
};

/**
 * @api {get} /boxes?date=:date&phenomenon=:phenomenon&format=:format Get all senseBoxes
 * @apiDescription With the optional `date` and `phenomenon` parameters you can find senseBoxes that have submitted data around that time, +/- 2 hours, or specify two dates separated by a comma.
 * @apiName findAllBoxes
 * @apiGroup Boxes
 * @apiVersion 0.1.0
 * @apiParam {ISO8601Date} [date] One or two ISO8601 timestamps at which boxes should provide measurements. Use in combination with `phenomenon`.
 * @apiParam {String} [phenomenon] A sensor phenomenon (determined by sensor name) such as temperature, humidity or UV intensity. Use in combination with `date`.
 * @apiParam {String="json","geojson"} [format=json] the format the sensor data is returned in.
 * @apiSampleRequest https://api.opensensemap.org/boxes
 * @apiSampleRequest https://api.opensensemap.org/boxes?date=2015-03-07T02:50Z&phenomenon=Temperatur
 * @apiSampleRequest https://api.opensensemap.org/boxes?date=2015-03-07T02:50Z,2015-04-07T02:50Z&phenomenon=Temperatur
 */
const findAllBoxes = function findAllBoxes (req, res, next) {
  const activityAroundDate = (typeof req.params['date'] === 'undefined' || req.params['date'] === '') ? undefined : req.params['date'];
  const phenomenon = (typeof req.params['phenomenon'] === 'undefined' || req.params['phenomenon'] === '') ? undefined : req.params['phenomenon'];

  const format = requestUtils.getRequestedFormat(req, ['json', 'geojson'], 'json');
  if (typeof format === 'undefined') {
    return next(new restify.InvalidArgumentError(`Invalid format: ${req.params['format']}`));
  }

  let fromDate,
    toDate,
    dates;

  if (activityAroundDate && (dates = activityAroundDate.split(',')) && dates.length === 2 && moment(dates[0]).isBefore(dates[1])) { // moment().isBefore() will check the date's validities as well
    fromDate = moment.utc(dates[0])
      .toDate();
    toDate = moment.utc(dates[1])
      .toDate();
  } else if (moment(activityAroundDate).isValid()) {
    fromDate = moment.utc(activityAroundDate).subtract(4, 'hours')
      .toDate();
    toDate = moment.utc(activityAroundDate).add(4, 'hours')
      .toDate();
  }

  // prepare query & callback
  let boxQry = Box.find({}).populate('sensors.lastMeasurement');
  const boxQryCallback = function (err, boxes) {
    // extend/update 'lastMeasurement' to the queried date
    const sensorQrys = [];
    if (typeof activityAroundDate !== 'undefined') {
      boxes.forEach(function (box) {
        box.sensors.forEach(function (sensor) {
          sensorQrys.push(
            Measurement.findOne({
              sensor_id: sensor._id,
              createdAt: {
                '$gt': fromDate,
                '$lt': toDate
              }
            })
            .lean()
            .exec()
          );
        });
      });
    }

    Promise.all(sensorQrys).then(function (thatresult) {
      // merge 'old' data that was queried according to the date/timestamp into the box result set
      // by replacing the "lastMeasurement" attribute's values with one fitting the query
      if (typeof activityAroundDate !== 'undefined'/* && typeof phenomenon !== 'undefined'*/) {
        const _boxes = boxes.slice();
        // TODO: too many loops
        _boxes.forEach(function (box) {
          box.sensors.forEach(function (sensor) {
            thatresult.forEach(function (thisresult) {
              if (thisresult !== null) {
                if (sensor.lastMeasurement) {
                  if (thisresult.sensor_id.toString() === sensor._id.toString()) {
                    sensor.lastMeasurement = thisresult;
                  }
                }
              }
            });
          });
        });

        return (_boxes);
      }

      return (boxes);
    })
      .then(function (result_boxes) {
      // clean up result..
        return result_boxes.map(function (box) {
          box.__v = undefined;
          box.mqtt = undefined;

          box.sensor = box.sensors.map(function (sensor) {
            sensor.__v = undefined;
            if (sensor.lastMeasurement) {
              sensor.lastMeasurement.__v = undefined;
            }

            return sensor;
          });

          box.loc[0]._id = undefined;

          return box;
        });
      })
      .then(function (resultset) {
        if (format === 'json') {
          res.send(resultset);
        } else if (format === 'geojson') {
          let tmp = JSON.stringify(resultset);
          tmp = JSON.parse(tmp);
          const geojson = _.transform(tmp, function (result, n) {
            const lat = n.loc[0].geometry.coordinates[1];
            const lng = n.loc[0].geometry.coordinates[0];
            n['loc'] = undefined;
            n['lat'] = lat;
            n['lng'] = lng;

            return result.push(n);
          });
          res.send(GeoJSON.parse(geojson, { Point: ['lat', 'lng'] }));
        }

      })
      .catch(function (err) {
        console.log(err);
        Honeybadger.notify(err);

        return next(new restify.InternalServerError(JSON.stringify(err)));
      });
  };

  // if date and phenom. are specified then filter boxes,
  // otherwise show all boxes
  if (typeof activityAroundDate !== 'undefined') {
    Measurement.find({
      createdAt: {
        '$gt': fromDate,
        '$lt': toDate
      }
    })
      .lean()
      .distinct('sensor_id', function (err, measurements) {
        let qry = {
          'sensors._id': {
            '$in': measurements
          }
        };
        if (typeof phenomenon !== 'undefined') {
          qry = {
            'sensors._id': {
              '$in': measurements
            },
            'sensors.title': phenomenon
          };
        }
        boxQry = Box.find(qry).populate('sensors.lastMeasurement');
        boxQry.exec(boxQryCallback);
      });
  } else {
    boxQry.exec(boxQryCallback);
  }
};

/**
 * @api {get} /boxes/:boxId Get one senseBox
 * @apiName findBox
 * @apiVersion 0.0.1
 * @apiGroup Boxes
 * @apiUse BoxIdParam
 * @apiParam {String="json","geojson"} [format=json] the format the sensor data is returned in.
 * @apiSuccessExample Example data on success:
 * {
  "_id": "57000b8745fd40c8196ad04c",
  "boxType": "fixed",
  "createdAt": "2016-06-02T11:22:51.817Z",
  "exposure": "outdoor",
  "grouptag": "",
  "image": "57000b8745fd40c8196ad04c.png?1466435154159",
  "loc": [
    {
      "geometry": {
        "coordinates": [
          7.64568,
          51.962372
        ],
        "type": "Point"
      },
      "type": "feature"
    }
  ],
  "name": "Oststr/Mauritzsteinpfad",
  "sensors": [
    {
      "_id": "57000b8745fd40c8196ad04e",
      "lastMeasurement": {
        "value": "0",
        "createdAt": "2016-11-11T21:22:01.675Z"
      },
      "sensorType": "VEML6070",
      "title": "UV-Intensität",
      "unit": "μW/cm²"
    },
    {
      "_id": "57000b8745fd40c8196ad04f",
      "lastMeasurement": {
        "value": "0",
        "createdAt": "2016-11-11T21:22:01.675Z"
      },
      "sensorType": "TSL45315",
      "title": "Beleuchtungsstärke",
      "unit": "lx"
    },
    {
      "_id": "57000b8745fd40c8196ad050",
      "lastMeasurement": {
        "value": "1019.21",
        "createdAt": "2016-11-11T21:22:01.675Z"
      },
      "sensorType": "BMP280",
      "title": "Luftdruck",
      "unit": "hPa"
    },
    {
      "_id": "57000b8745fd40c8196ad051",
      "lastMeasurement": {
        "value": "99.38",
        "createdAt": "2016-11-11T21:22:01.675Z"
      },
      "sensorType": "HDC1008",
      "title": "rel. Luftfeuchte",
      "unit": "%"
    },
    {
      "_id": "57000b8745fd40c8196ad052",
      "lastMeasurement": {
        "value": "0.21",
        "createdAt": "2016-11-11T21:22:01.675Z"
      },
      "sensorType": "HDC1008",
      "title": "Temperatur",
      "unit": "°C"
    },
    {
      "_id": "576996be6c521810002479dd",
      "sensorType": "WiFi",
      "unit": "dBm",
      "title": "Wifi-Stärke",
      "lastMeasurement": {
        "value": "-66",
        "createdAt": "2016-11-11T21:22:01.675Z"
      }
    },
    {
      "_id": "579f9eae68b4a2120069edc8",
      "sensorType": "VCC",
      "unit": "V",
      "title": "Eingangsspannung",
      "lastMeasurement": {
        "value": "2.73",
        "createdAt": "2016-11-11T21:22:01.675Z"
      },
      "icon": "osem-shock"
    }
  ],
  "updatedAt": "2016-11-11T21:22:01.686Z"
}
 */

const findBox = function findBox (req, res, next) {
  const format = requestUtils.getRequestedFormat(req, ['json', 'geojson'], 'json');
  if (typeof format === 'undefined') {
    return next(new restify.InvalidArgumentError(`Invalid format: ${req.params['format']}`));
  }

  Box.findAndPopulateBoxById(req.boxId)
    .then(function (box) {
      if (box) {
        if (format === 'json') {
          res.send(box);
        } else if (format === 'geojson') {
          let tmp = JSON.stringify(box);
          tmp = JSON.parse(tmp);
          const lat = tmp.loc[0].geometry.coordinates[1];
          const lng = tmp.loc[0].geometry.coordinates[0];
          tmp['loc'] = undefined;
          tmp['lat'] = lat;
          tmp['lng'] = lng;
          const geojson = [tmp];
          res.send(GeoJSON.parse(geojson, { Point: ['lat', 'lng'] }));
        }
      } else {
        return next(new restify.NotFoundError('No senseBox found'));
      }
    })
    .catch(function (error) {
      const e = error.errors;
      Honeybadger.notify(error);

      return next(new restify.InternalServerError(e));
    });
};

/**
 * @api {post} /boxes Post new senseBox
 * @apiDescription Create a new senseBox. This method allows you to submit a new senseBox.
 *
 * Along with the senseBox, an user is created which then owns the senseBox.
 *
 * If you specify `mqtt` parameters, the openSenseMap API will try to connect to the MQTT broker
 * specified by you. The parameter `messageFormat` tells the API in which format you are sending
 * measurements in.
 *
 * For `json`, the format is:
 * ```
 * {
 *   "sensorId": <value>,
 *   "sensorId": [<value>,<createdAt>]
 *   ...
 * }
 * ```
 *
 * For `csv`, the format is:
 * ```
 * sensorId,value
 * sensorId,value,createdAt
 * ...
 * ```
 * @apiVersion 0.0.1
 * @apiGroup Boxes
 * @apiName postNewBox
 * @apiUse CommonBoxJSONBody
 * @apiUse UserBody
 * @apiUse SensorBody
 * @apiUse MqttBody
 *
 * @apiParam (RequestBody) {User} user the user for this senseBox.
 * @apiParam (RequestBody) {String} orderID the apiKey of the user for the senseBox.
 */
const postNewBox = function postNewBox (req, res, next) {
  Box.newFromRequest(req)
    .then(function (user) {
      res.send(201, user);
    })
    .catch(function (err) {
      if (Array.isArray(err)) {
        return next(new restify.UnprocessableEntityError({ message: err.toString() }));
      } else if (err.toString().endsWith('Duplicate senseBox found')) {
        return next(new restify.BadRequestError(err.toString().slice(7)));
      }
      Honeybadger.notify(err);

      return next(new restify.InternalServerError(err.message));
    });
};

/**
 * @api {get} /boxes/:senseBoxId/script Download the Arduino script for your senseBox
 * @apiName getScript
 * @apiGroup Boxes
 * @apiVersion 0.1.0
 * @apiUse AuthorizationRequiredError
 * @apiUse BoxIdParam
 */
const getScript = function getScript (req, res, next) {
  Box.findById(req.boxId)
    .then(function (box) {
      const file = `${config.targetFolder}${box._id}.ino`;

      if (!fs.existsSync(file)) {
        sketches.generateSketch(box);
      }

      return res.send(200, fs.readFileSync(file, 'utf-8'));
    })
    .catch(function (err) {
      Honeybadger.notify(err);

      return next(new restify.NotFoundError(err.message));
    });
};

/**
 * @api {delete} /boxes/:senseBoxId Delete a senseBox and its measurements
 * @apiName deleteBox
 * @apiGroup Boxes
 * @apiVersion 0.1.0
 * @apiUse AuthorizationRequiredError
 * @apiUse BoxIdParam
 */
const deleteBox = function deleteBox (req, res, next) {
  Box.deleteBox(req.boxId)
    .then(function () {
      res.send(200, 'Box deleted');
    })
    .catch(function (err) {
      if (err === 'senseBox not found') {
        return next(new restify.NotFoundError(err));
      }
      Honeybadger.notify(err);

      return next(new restify.InternalServerError(err));
    });
};

module.exports = {
  deleteBox,
  getScript,
  getData,
  getDataMulti,
  updateBox,
  getMeasurements,
  postNewMeasurement,
  postNewMeasurements,
  postNewBox,
  findBox,
  findAllBoxes
};
