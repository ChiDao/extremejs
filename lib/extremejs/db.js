'use strict';

var mongodb = require('mongodb');

exports.connect = function(host, port, dbname, callback) {
  var conn = new mongodb.Db(dbname, 
      new mongodb.Server(host, port, {auto_reconnect: true, poolSize: 10}), {safe:true});
  conn.open(callback);
}

exports.find = function(db, coll, query, options, callback, fields) {

  if(typeof(options) == 'function') {
    callback = options;
    options = {};
  }

  db.collection(coll, function(err, coll) {
    if(err) {
      callback(err);
      return;
    }
    if(! fields) 
      coll.find(query, options).toArray(callback);
    else
      coll.find(query, fields, options).toArray(callback);
 });
}

exports.count = function(db, coll, query, options, callback) {

  if(typeof(options) == 'function') {
    callback = options;
    options = {};
  }

  db.collection(coll, function(err, coll) {
    if(err) {
      callback(err);
      return;
    }
    coll.find(query, options).count(callback);
 });
}

exports.insert = function(db, coll, doc, callback) {

  db.collection(coll, function(err, coll) {
    if(err) {
      callback(err);
      return;
    }
    coll.insert(doc, {safe: true},  callback);
 });
}

exports.update = function(db, coll, cond, doc, upsert, multiply, callback) {

  db.collection(coll, function(err, coll) {
    if(err) {
      callback(err);
      return;
    }
    coll.update(cond, doc, {safe:true, upsert: upsert, multi:multiply}, callback);
 });
}

exports.remove = function(db, coll, doc, callback) {

  db.collection(coll, function(err, coll) {
    if(err) {
      callback(err);
      return;
    }
    coll.remove(doc, {safe: true},  callback);
 });
}

exports.ensureIndex = function(db, coll, index, options, callback) {

  db.collection(coll, function(err, coll) {
    if(err) {
      callback(err);
      return;
    }
    coll.ensureIndex(index, options, callback);
 });
}

exports.mapReduce = function(db, coll, query, map, reduce, options, callback) {
  db.collection(coll, function(err, coll) {
    if(err) {
      callback(err);
      return;
    }
    coll.mapReduce(map, reduce, options, function(err, collection, stats) {
      if(err) {
	    callback(err);
	    return;
	  }
      if(options.out.inline)
    	callback(err, collection);
      else
        coll.find(query, {}).toArray(callback);
    });
 });
}
