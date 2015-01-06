"use strict";

var util = require('./util');
var mongodb = require('./db');
var URL = require('url');
var Cookies = require('cookies');
var crypto = require('crypto');
var async = require('async');

var resources = {};
var waitings = {};
var beforeHooks = {};
var afterHooks = {};
var docs = {};
var embeds = {};

function objectKeys(obj) {
  var ret = [];
  for(var k in obj)
    ret.push(k);
  return ret;
}

function ensureIndex(callback) {
  var objects = [];
  for(var k in resources) {
    var v = resources[k];
    if(v.type == 'object' && ! v.edit)
      objects.push(v);
  }
  if(objects.length == 0) {
    callback(null);
    return;
  }

  function iter(n) {
    if(n == objects.length)
      callback(null);
    else {
      var idx = {};
      var ps = objects[n].properties;
      var ref = objects[n].ref;
      var entity = objects[n].entity;
      var def = resources[entity].def;
      for(var i in ps) {
        var p = ps[i];
        if(!def[p] && p!='_id') continue;
        if(p!='_id' && isOptionalType(def[p])) {
          callback(new Error(entity + '.' + p + ' is optional'));
          return;
        }
        idx[p] = 1;
      }
      for(var p in ref) {
        if(p.indexOf('_') == 0) continue;
        if(!def[p] || isOptionalType(def[p])) {
          callback(new Error(entity + '.' + p + ' not define or optional'));
          return;
        }
        idx[p] = 1;
      }
      if(objectKeys(idx).length == 0) {
        iter(n+1);
        return;
      }
      mongodb.ensureIndex(exports.db, entity, idx, {unique: true}, 
          function(err) {
            if(err == null)
              iter(n+1);
            else
              callback(err);
          });
    }
  }
  iter(0);
}

function isStringType(value) {
  return value && value.match(/\bstring\b/) != null;
}

function isString(value) {
  return typeof(value) == 'string';
}

function isNumberType(value) {
  return value.match(/\bnumber\b/) != null;
}

function isNumber(value) {
  return typeof(value) == 'number';
}

function isBooleanType(value) {
  return value.match(/\bboolean\b/) != null;
}
function isBoolean(value) {
  return typeof(value) == 'boolean';
}

function isDateType(value) {
  return value.match(/\bdate\b/) != null;
}
function isDate(value) {
  return value instanceof Date || isString(value) && ! isNaN(Date.parse(value));
}

function isIntegerType(value) {
  return value.match(/\binteger\b/) != null;
}

function isInteger(value) {
  return isNumber(value) && value % 1 == 0;
}

function isGeoType(value) {
  return value.match(/\bgeo\b/) != null;
}

function isGeo(value) {
  var ret = isObject(value) && isNumber(value.lat) && isNumber(value.long);
  if(ret) {
    var lon = value.long;
    var lat = value.lat;
    delete value.lat;
    delete value.long;
    value.long = lon;
    value.lat = lat;
  }
  return ret;
}

function isSetType(value) {
  return value.match(/\bset\b/) != null;
}

function isSet(value) {
  return isArray(value) && value.every(function(i) { return isString(i); });
}
function isObjectType(value) {
  return value.match(/\bobject\b/) != null;
}
function isObject(value) {
  return typeof(value) == 'object' && value != null;
}

function isArray(value) {
  return value instanceof Array;
}

function isOptionalType(value) {
  return value.match(/\boptional\b/) != null;
}
function isMatchType(type, value) {
  if(! isString(type)) return false;
  if(isStringType(type) && isString(value) ||
      isNumberType(type) && isNumber(value) ||
      isIntegerType(type) && isInteger(value) ||
      isBooleanType(type) && isBoolean(value) ||
      isDateType(type) && isDate(value) ||
      isGeoType(type) && isGeo(value) ||
      isSetType(type) && isSet(value) ||
      isObjectType(type) && isObject(value)) {

    return true;
  }
  else 
    return isOptionalType(type) && value == null;
}

function convertValue(type, value) {
  if(! isDateType(type))
    return value;
  else
    return new Date(value);
}

function typedef2entityname(type) {
  return type.trim().split(/\s+/)[0];
}
function isMatchEntityType(type, value) {
  if(value == null) return true;
  var name = typedef2entityname(type);
  var urln = urlname(value);
  var id = urlId(value);
  return isEntityType(type) && name == urln && id != null;
}

function isEntityName(value) {
  var res = resources[value];
  if(res == null) return false;
  var t = res.type;
  return t == 'entity';
}
function isEntityType(value) {
  if(! isString(value)) return false;
  var name = typedef2entityname(value);
  return isEntityName(name);
}

function isLinkName(value) {
  var res = resources[value];
  if(res == null) return false;
  var t = res.type;
  return t == 'object' || t == 'stream' || t == 'const' || t == 'query';
}

function isObjectName(value) {
  var res = resources[value];
  if(res == null) return false;
  var t = res.type;
  return t == 'object';
}

function isStreamName(value) {
  var res = resources[value];
  if(res == null) return false;
  var t = res.type;
  return t == 'stream';
}

function isQueryName(value) {
  var res = resources[value];
  if(res == null) return false;
  var t = res.type;
  return t == 'query';
}

function isConstName(value) {
  var res = resources[value];
  if(res == null) return false;
  var t = res.type;
  return t == 'const';
}

function isFuncConstName(value) {
  return isConstName(value) && typeof(resources[value].def) == 'function'
}

function isObjectConstName(value) {
  return isConstName(value) && typeof(resources[value].def) == 'object'
}

function isLink(value) {
  return isArray(value) && isLinkName(value[0]);
}
function object2time(obj) {
  if (obj instanceof Date)
    return obj.getTime();
  else
    return Date.parse(obj);
}
function input(url, json, context) {
  var entity = urlentity(url);
  var ref = resources[urlname(url)].ref;
  var ret = {};
  var def = resources[entity].def;
  if(json['_id']) {
    ret['_id'] = json['_id'];
    if(json['_modified']) { 
      var ts = object2time(json['_modified']);
      if(isNaN(ts)) return 400;
      else ret['_modified'] = new Date(ts);
    }
    else return 400;
    if(json['_created']) { 
      var ts = object2time(json['_created']);
      if(isNaN(ts)) return 400;
      else ret['_created'] = new Date(ts);
    }
    else return 400;
  }
  else {
    if(!json['_rawModified'])
      ret['_modified'] = new Date();
    else
      ret['_modified'] = new Date(json['_rawModified']);

    if(!json['_rawCreated'])
      ret['_created'] = new Date();
    else {
      var rawCreated = new Date(json['_rawCreated']);
      ret['_created'] = rawCreated; 
      ret['_rawCreated'] = rawCreated;
    }
  }
  for(var k in def) { 
    if(! isString(def[k])) continue;
    if(isMatchType(def[k], json[k])) {
      if(json[k] != null)
        ret[k] = convertValue(def[k], json[k]);
    }
    else if(isMatchEntityType(def[k], json[k]))
      if(json[k] != null) {
        ret[k] = urlId(json[k]);
      }
    else if(json[k] != null){
      console.log('Type Error: %s.%s def: %s value: %j', 
          entity, k, def[k], json[k]);
      return 400;
    }
  }
  for(var k in context)  {
    if(isMatchType(def[k], context[k])) 
      ret[k] = convertValue(def[k], context[k]);
    else if(isEntityType(def[k]))
      ret[k] = context[k];
  }
  if(ref) {
    for(var p in ref) {
      var c = ref[p];
      var cv = c.substring(1);
      if(c[0] == '$' && context[cv])
        ret[p] = context[cv];
      else return 401;
    }
  }
  for(var k in def) { 
    if(! isString(def[k])) continue;
    if(! isOptionalType(def[k]) && ret[k] == null) {
      console.log('Type Error: %s.%s def: %s value: null', 
          entity, k, def[k]);
      return 400;
    }
  }
  

  return ret;
}
function urlprefix(url) {
  var p = URL.parse(url);
  if(p.protocol && p.host)
    return p.protocol + '//' + p.host;
  else 
    return '';
}
function makeUrl(template, object, context, url) {
  var prefix = '';
  if(url != null)
    prefix = urlprefix(url);
  var urlname = template[0];
  var ret = prefix + '/' + urlname;
  var tail = template[1];
  var path = [];
  for(var i in tail) {
    var name = tail[i];
    if(name[0] == '$') {
      name = name.substring(1);
      if(object[name]) path.push(object[name]);
      else if(context[name]) path.push(context[name]);
      else return null;
    }
    else
      path.push(name);
  }
  path = path.map(function(i) { return encodeURIComponent(i);});
  if(path.length > 0)
    ret += '/' + path.join('/');
  //if(resources[urlname].type == 'stream')
   // ret += '?_last=';
  return ret;
}
function makeEntityUrl(name, id, url) {
  name = typedef2entityname(name);
  var prefix = '';
  if(url != null)
    prefix = urlprefix(url);
  return prefix + '/' + name + '/' + id;
}
function output(name, json, context, url) {
  var ret = {};
  var def = resources[name].def;
  var id = json['_id'];
  ret['_id'] = id;
  ret['_self'] = makeEntityUrl(name, id, url);

  for(var k in def) {
    if(isLink(def[k])) {
      var link = makeUrl(def[k], json, context, url);
      if(link != null) ret[k] = link;
    }
    else if(isMatchType(def[k], json[k])) {
      ret[k] = json[k];
    }
    else if(isEntityType(def[k])) {
      ret[k] = makeEntityUrl(def[k], json[k], url);
    }
  }
  if(json['_modified']) ret['_modified'] = json['_modified'];
  if(json['_created']) ret['_created'] = json['_created'];
  return ret;
}
function constOutput(def, context, url) {
  var ret = {};
  for(var k in def) {
    if(isLink(def[k])) {
      var link = makeUrl(def[k], {}, context, url);
      if(link != null) ret[k] = link;
    }
  }
  return ret;
}
function urlpath(url) {
  return URL.parse(url).pathname;
}

function path2array(path) {
  var array = path.substring(1).split('/');
  return array.map(function(i) { return decodeURIComponent(i);});
}

function pathname(path) {
  return path2array(path)[0];
}

function pathId(path) {
  return path2array(path)[1];
}

function urlname(url) {
  try {
    return pathname(urlpath(url));
  }
  catch(err) {
    return null;
  }
}

function urlId(url) {
  try {
    return pathId(urlpath(url));
  }
  catch(err) {
    return null;
  }
}

function patharray2context(path) {
  var name = path[0];
  var values = path.slice(1);
  var properties = resources[name].properties;
  var ret = {};
  for(var i in properties) {
    var p = properties[i];
    var v = values[i];
    ret[p] = v;
  }
  return ret;
}

function patharray2query(path, context) {
  var name = path[0];
  var values = path.slice(1);
  var properties = resources[name].properties;
  var ref = resources[name].ref;
  var def = resources[resources[name].entity].def;
  var ret = {};
  for(var i in properties) {
    var p = properties[i];
    var v = values[i];
    if(isArray(v)) 
      ret[p] = {'$in': v};
    else
      ret[p] = v;
  }
  if(ref) {
    if(context) {
      for(var p in ref) {
        var c = ref[p];
        var cv = c.substring(1);
        if(c[0] == '$' &&context[cv]) ret[p] = context[cv];
        else return null;
      }
    }
    else return null;
  }
  return ret;
}

function path2context(path) {
  return patharray2context(path2array(path));
}

function url2context(url) {
  return path2context(urlpath(url));
}
function path2query(path, context) {
  return patharray2query(path2array(path), context);
}

function url2query(url, context) {
  return path2query(urlpath(url), context);
}
function urlentity(url) {
  var name = urlname(url);
  if(isEntityName(name)) return name;
  var res = resources[name];
  if(res.type != 'const')
    return resources[name].entity;
  else
    return name;
}
function objectJoin(obj1, obj2) {
  var ret = {};
  if(obj1 == null) obj1 = {};
  if(obj2 == null) obj2 = {};
  for(var i in obj1) 
    ret[i] = obj1[i];
  for(var i in obj2) 
    ret[i] = obj2[i];
  return ret;
}
function objectMerge(orig, apend) {
  var ret = {};
  if(orig == null) orig = {};
  if(apend == null) apend = {};
  for(var i in apend) {
    if(orig[i])
      orig[i] = apend[i];
  }
  return orig;
}
function inputUrl(url, object, context, err) {
  var uc = url2context(url);
  context = objectJoin(context, uc);
  var ret = input(url, object, context);
  if(typeof(ret) != 'number') 
    return ret;
  else {
    if(err) err.code = ret;
    return null;
  }
    

}

function parseJSON(req, callback) {
  var contentType = parseInt(req.headers['content-length']);
  if(isNaN(contentType) || contentType > 100 * 1024) {
    callback(null);
    return;
  }
  var buffer = new Buffer(contentType);
  var pos = 0;
  req.addListener('data', function(chunk) {
    chunk.copy(buffer, pos, 0, chunk.length);
    pos += chunk.length;
  });
  req.addListener('end', function() {
    var json = null;
    try {
      json = JSON.parse(buffer.toString('utf8'));
    }
    catch(e) {
      callback(null);
      return;
    }
    callback(json);

  });
}

function outputUrl(url, object, context) {
  var name = urlentity(url);
  var uc = url2context(url);
  context = objectJoin(context, uc);
  return output(name, object, context, url);
}

function objectConstGet(url, callback, context) {
  var uc = url2context(url);
  context = objectJoin(context, uc);
  var name = urlname(url);
  var def = resources[name].def;
  var obj = constOutput(def, context, url);
  callback(200, obj);
}
function funcConstGet(url, callback, context) {
  funcConstOp('get', url, null, callback, context);
}
function objectGet(url, callback, context) {

  var query = url2query(url, context);
  var edit = resources[urlname(url)].edit;
  if(query == null) {
    callback(401, null);
    return;
  }
  mongodb.find(exports.db, urlentity(url), query, function(err, docs) {
    if(err == null) {
      if(!edit) {
        if(docs.length > 0)
          callback(200, outputUrl(url, docs[0], context));
        else
          callback(404, null);
      }
      else {
        if(docs.length > 0)
          callback(204, null);
        else
          callback(403, null);
      }
    }
    else
      callback(500, null);
  });
}
function entityGet(url, callback, context) {
  var id = urlId(url);
  mongodb.find(exports.db, urlname(url), {_id: id}, function(err, docs) {
    if(err == null) {
      if(docs.length > 0)
        callback(200, outputUrl(url, docs[0], context));
      else
        callback(404, null);
    }
    else
      callback(500, null);
  });
}
function urlqry(url) {
  var p = URL.parse(url, true);
  if(p.search != '') return p.query;
  else return null;
}
function urlsetqry(url, qry) {
  var p = URL.parse(url, true);
  delete p.search;
  var q = {}
  if(p.query) {
    for(var k in p.query)
      if(k.indexOf('_') != 0)
        q[k] = p.query[k];
  }
  p.query = objectJoin(q, qry);
  return URL.format(p);
}
function streamObject(url, slice, context) {
  var ret = {};
  var name = urlname(url);
  ret.first = urlsetqry(url, {_first:''});
  ret.last = urlsetqry(url, {_last:''});
  if(resources[name].count)
    ret.count = urlsetqry(url, {_count:''});
  if(slice != null) {
    ret.prev = urlsetqry(url, {_prev:slice[0]._id});
    ret.next = urlsetqry(url, {_next:slice[slice.length-1]._id});
    ret.slice = slice.map(function(item) {
      return outputUrl(url, item, context);
    });
  }
  return ret;
}
function streamCountGet(url, query, callback, context) {
  var name = urlname(url);
  if(!resources[name].count) {
    callback(404);
    return;
  }
  var qry = url2query(url, context);
  if(qry == null) {
    callback(401, null);
    return;
  }
  if(query != null)
    for(var f in query)
        qry[f] = query[f];
  mongodb.count(exports.db, urlentity(url), qry, function(err, count) {
    if(err != null) callback(500, null);
    else callback(200, {value:count});
  });

}
function parseUrlLimit(url) {
  var params = urlqry(url);
  if(!params) return 20;
  return params['n']?params['n']:20;
}
function streamNextGet(url, query, callback, context) {
  var opt = {limit: parseUrlLimit(url), sort:[['_id', 'asc']]};
  var qry = url2query(url, context);
  if(qry == null) {
    callback(401, null);
    return;
  }
  if(query != null)
    for(var f in query)
        qry[f] = query[f];
  var next = urlqry(url)._next;
  if(next) qry._id = {$gt:next};
  mongodb.find(exports.db, urlentity(url), qry, opt, function(err, docs) {
    if(err != null) callback(500, null);
    else if(docs.length == 0) callback(404, null);
    else callback(200, streamObject(url, docs, context));
  });

}
function streamPrevGet(url, query, callback, context) {
  var opt = {limit: parseUrlLimit(url), sort:[['_id', 'desc']]};
  var qry = url2query(url, context);
  if(qry == null) {
    callback(401, null);
    return;
  }
  if(query != null)
    for(var f in query)
        qry[f] = query[f];
  var prev = urlqry(url)._prev;
  if(prev) qry._id = {$lt:prev};
  mongodb.find(exports.db, urlentity(url), qry, opt, function(err, docs) {
    if(err != null) callback(500, null);
    else if(docs.length == 0) callback(404, null);
    else callback(200, streamObject(url, docs.reverse(), context));
  });
}
function streamQryGet(url, pos, qry, callback, context) {
  if(pos._first == '')
    streamNextGet(url, qry, callback, context);
  else if(pos._last == '')
    streamPrevGet(url, qry, callback, context);
  else if(pos._prev)
    streamPrevGet(url, qry, callback, context);
  else if(pos._next)
    streamNextGet(url, qry, callback, context);
  else if(pos._count == '')
    streamCountGet(url, qry, callback, context);
  else callback(400, null);
}
function hasStreamParam(qry) {
  var sp = ['_first', '_last', '_next', '_prev', '_count'];
  for(var k in qry)
    if(sp.indexOf(k) != -1) return true;
  return false;
}
function cometWaitingUrl(url) {
  var qry = urlqry(url);
  var sp = ['_last', '_next'];
  for(var k in qry)
    if(sp.indexOf(k) != -1) return true;
  return false;
}
function queryObject(url, slice, context) {
  var ret = {};
  var name = urlname(url);
  ret.first = urlsetqry(url, {_start:0});
  if(slice != null) {
    var oldstart = parseInt(urlqry(url)._start);
    ret.next = urlsetqry(url, {_start:oldstart + slice.length});
    ret.slice = slice.map(function(item) {
      return outputUrl(url, item, context);
    });
  }
  return ret;
}
function queryNextGet(url, query, sort, callback, context) {
  var qry = {};
  if(query != null)
    for(var f in query)
        qry[f] = query[f];
  var start = parseInt(urlqry(url)._start);
  var opt = {skip: start, limit: 20, sort:sort};
  mongodb.find(exports.db, urlentity(url), qry, opt, function(err, docs) {
    if(err != null) callback(500, null);
    else if(docs.length == 0) callback(404, null);
    else callback(200, queryObject(url, docs, context));
  });

}
function queryGet(url, callback, context) {
  var qry = urlqry(url);
  var elemqry = url2query(url, context);
  qry = objectJoin(qry, elemqry);
  if(qry == null || !qry._start)
    callback(200, queryObject(url, null, context));
  else {
    var query = resources[urlname(url)];
    query.query(qry, context, function(code, query) {
      if(code < 300) {
        var sort = query._sort;
        delete query._sort;
        queryNextGet(url, query, sort, callback, context); 
      }
      else
        callback(code, null);
    });
  }
}
function _streamGet(url, callback, context) {
  var pos = urlqry(url);
  if(pos == null || ! hasStreamParam(pos)) {
    callback(200, streamObject(url));
    return;
  }
  var stream = resources[urlname(url)];
  if(stream.query) {
    stream.query(url, url2context(url), context, function(code, query) {
      if(code < 300)
        streamQryGet(url, pos, query, callback, context);
      else
        callback(code, null);

    });
  }
  else 
    streamQryGet(url, pos, null, callback, context);
}
function releaseWaitObj(wo) {
  if(wo.timer)
    clearTimeout(wo.timer);
  _streamGet(wo.url, function(code, obj) {
    if(code == 404) {
      var so = streamObject(wo.url, null, wo.context);
      so.next = wo.url;
      so.prev = so.last;
      so.slice = [];
      wo.callback(200, so);
    }
    else 
      wo.callback(code, obj);
  }, wo.context);
}
function releaseAllWaitObj(url) {
  var path = urlpath(url);
  var list = waitings[path];
  delete waitings[path];
  while(list) {
    releaseWaitObj(list);
    list = list.next;
  }
}
function streamGet(url, callback, context) {
  var name = urlname(url);
  if(!resources[name].comet)
    _streamGet(url, callback, context);
  else {
    _streamGet(url, function(code, obj) {
      if(code == 404 && cometWaitingUrl(url)) {
        var waitObj = {
          url:url,
          callback:callback,
          context:context
        };
        var path = urlpath(url);
        waitObj.next = waitings[path];
        waitings[path] = waitObj;
        waitObj.timer = setTimeout(function() {
          var list = waitings[path];
          var prev = null;
          while(list) {
            if(list == waitObj) {
              list.timer = null;
              if(prev) prev.next = list.next;
              else {
                waitings[path] = list.next;
                if(!list.next) {
                  delete waitings[path];
                }
              }
              releaseWaitObj(list);
              break;
            }
            prev = list;
            list = list.next;
          }
        }, 15 * 1000);
      }
      else
        callback(code, obj);
    }, context);
  }
}
function streamPost(url, object, callback) {
  object._id = util.id();
  if(object._rawCreated) {
    object._id = util.idForDate(object._rawCreated);
    delete object._rawCreated;
  }
  var entity = urlentity(url);
  mongodb.insert(exports.db, entity, object, function(err, doc) {
    if(err == null) {
      callback(201, object);
      var uname = urlname(url);
      if(resources[uname].comet) 
        releaseAllWaitObj(url);
    }
    else if(err.code == 11000) {
      console.log(err);
      callback(409, null);
    }
    else {
      console.log(err);
      callback(500, null);
    }
  });
}

function streamPatch(url, object, callback, context) {
  var query = url2query(url, context);
  var entity = urlentity(url);
  mongodb.find(exports.db, entity, query, {}, function(err, docs) {
    if(err != null) {
      console.log(err);
      callback(500, null);
    }
    var count = docs.length;
    if(count > 0) {
      object._modified = new Date();
      mongodb.update(exports.db, entity, query, {$set:object}, false, true, function(err, doc) {
    	if(err == null)
          callback(200, {value:count});
        else if(err.code == 11000) {
          console.log(err);
          callback(409, null);
        } else {
          console.log(err);
          callback(500, null);
        }
      });
    } else {
      callback(200, {value:0});
    }
  }); 
}

function objectPut(url, object, callback) {
  var entity = urlentity(url);
  var edit = resources[urlname(url)].edit;
  if(edit) {
    callback(405, null);
    return;
  }
  if(! object._id) {
    object._id = util.id();
    mongodb.insert(exports.db, entity, object, function(err, doc) {
      if(err == null)
        callback(201, object);
      else if(err.code == 11000) {
        console.log(err);
        callback(409, null);
      }
      else {
        console.log(err);
        callback(500, null);
      }
    });
  }
  else {
    var cond = {};
    var oldm = object._modified;
    object._modified = new Date();
    cond._id = object._id;
    cond._modified = oldm;
    cond._created = object._created;
    mongodb.update(exports.db, entity, cond, object, true, false, function(err, doc) {
      if(err == null)
        callback(200, object);
      else if(err.code == 11000) {
        console.log(err);
        callback(409, null);
      } else {
        console.log(err);
        callback(500, null);
      }
    });
  }
}
function objectDelete(url, context, callback) {
  var entity = urlentity(url);
  var edit = resources[urlname(url)].edit;
  var cond = url2query(url, context);
  if(cond == null) {
    callback(401, null);
    return;
  }
  mongodb.remove(exports.db, entity, cond, function(err, n) {
    if(err == null)
      if(!edit)
        callback(204, null);
      else {
        if(n > 0) 
          callback(204);
        else
          callback(403);
      }
    else {
      console.log(err);
      callback(500, null);
    }
  });
}
function funcConstOp(method, url, object, callback, context) {
  var params = url2context(url);
  var req = {method:method,context:context, params:params, 
    entity:object, url:url};
  var name = urlname(url);
  var func = resources[name].def;
  func(req, callback);
}


exports.db = null;

var clipher = null;
var decipher = null;
var key = null;

exports.setKey = function(k) {
  key = k;
}

function encodeJSON(json) {
  var str = JSON.stringify(json);
  var cipher = crypto.createCipher('des', key);
  var result = cipher.update(str, 'utf8', 'base64');
  result += cipher.final('base64');
  return result;
}

function decodeJSON(str) {
  var decipher = crypto.createDecipher('des', key);
  var result = decipher.update(str, 'base64', 'utf8');
  result += decipher.final('utf8');
  if(result == '') return null;
  else {
    try {
      return JSON.parse(result);
    }
    catch(err) {
      return null;
    }
  }
}
exports.connect = function(host, port, db, callback) {
  mongodb.connect(host, port, db, function(err, d){
    if(err == null) {
      exports.db = d;
      ensureIndex(function(err) {
        callback(err);
      });
    }
    else
      callback(err);
  });
}

exports.entity = function(name, def) {
  resources[name] = {type:'entity', def:def};
}

exports.object = function(name, entity, properties, contextRef) {
  resources[name] = {  type:         'object', 
                       entity:       entity, 
                       properties:   properties,
                       ref:          contextRef};
}
exports.edit = function(name, entity, properties, contextRef) {
  resources[name] = {  type:         'object', 
                       edit:         true,
                       entity:       entity, 
                       properties:   properties,
                       ref:          contextRef};
}

exports.stream = function(name, entity, properties, contextRef, query) {

  if(arguments.length ==4 ) {
    var def = {type:         'stream', 
               entity:       entity, 
               properties:   properties, };
    var type = typeof(contextRef);
    if(type == 'function')
      def.query = contextRef;
    else if(type == 'object')
      def.ref = contextRef;
    else 
      throw new Error('Type Error: ' + type);
    resources[name] = def;
  }
  else
    resources[name] = {type:         'stream', 
                       entity:       entity, 
                       properties:   properties,
                       ref:          contextRef,
                       query:        query};
}

exports.setComet = function(name) {
  resources[name].comet = true;
}

exports.setCount = function(name) {
  resources[name].count = true;
}

exports.resource = function(name, params, def) {
  resources[name] = {type:'const', properties:params, def:def};
}

exports.before = function(resource, hookFunc) {
  beforeHooks[resource] = hookFunc;
}
exports.after = function(resource, hookFunc) {
  afterHooks[resource] = hookFunc;
}

exports.url = function(name, params, base) {
  var prefix = '';
  if(base != null)
    prefix = urlprefix(base);
  params = params.map(function(i) { return encodeURIComponent(i);});
  return prefix + '/' + name + '/' + params.join('/');
}

exports.urlelement = function(url) {
  return url2context(url);
}
exports.getStream = function(stream, field, params, context, callback) {
  var path = [stream].concat(params);
  var query = patharray2query(path, context);
  if(query == null) {
    callback(401, null);
    return;
  }
  var entity = resources[stream].entity;
  var fields = {};
  fields[field] = 1;
  mongodb.find(exports.db, entity, query, {}, function(err, docs) {
    if(err != null) callback(500, null);
    var ids = docs.map(function(i) { return i[field];});
    callback(200, ids);
  }, fields);
}

exports.mapReduce = function(entity, query, map, reduce, options, callback) {
  var opts = {
    mapreduce: entity,
    keytemp: true,
    verbose: true
  };
  opts = util.merge(opts, options);
  //console.log(opts);
  mongodb.mapReduce(exports.db, entity, query, map, reduce, opts, callback);
}

exports.query = function(name, entity, properties, query, contextRef) {
  resources[name] = {  type:         'query', 
                       entity:       entity, 
                       properties:   properties,
                       query:         query,
                       ref:          contextRef};
}
exports.object = function(name, entity, properties, contextRef) {
  resources[name] = {  type:         'object', 
                       entity:       entity, 
                       properties:   properties,
                       ref:          contextRef};
}

exports.get = function(url, callback, context) {
  var name = urlname(url);
  if(isObjectConstName(name)) {
    objectConstGet(url, function(code, ret) {
          if(code < 300)
              callback(code, ret);
          else
              callback(code, ret);
        }, context);
  }
  else if(isFuncConstName(name)) {
    funcConstGet(url, callback, context);
  }
  else if(isObjectName(name)) {
    objectGet(url, callback, context);
  }
  else if(isStreamName(name)) {
    streamGet(url, callback, context);
  }
  else if(isEntityName(name)) {
    entityGet(url, callback, context);
  }
  else if(isQueryName(name)) {
    queryGet(url, callback, context);
  }
  else {
    callback(405, null);
  }
}
function xrequest(method, url, input, callback, context) {
  var req = {};
  req.url = url;
  req.headers = [];
  req.method = method;
  req.ejXrequest = true;
  var res = {};
  res.setHeader = function(k,v){};
  res.writeHead = function(code) { 
    this.code = code; 
  };
  res.end = function(str) {
    if(str)
      callback(this.code, JSON.parse(str));
    else
      callback(this.code);
  };
  if(!context) context = {};
  processMethod(req, res, input, context);
}
exports.xget = function(url, callback, context) {
  xrequest('GET', url, null, callback, context);
}
exports.xdelete = function(url, callback, context) {
  xrequest('DELETE', url, null, callback, context);
}
exports.xpost = function(url, data, callback, context) {
  xrequest('POST', url, data, callback, context);
}
exports.xput = function(url, data, callback, context) {
  xrequest('PUT', url, data, callback, context);
}
exports.patch = function(url, object, callback, context) {
  var name = urlname(url);
  if(isStreamName(name)) {
	var err = {};
	streamPatch(url, object, function(code, ret) {
        callback(code, ret);
    }, context);
  } else {
    callback(405, null);
  }
}

exports.post = function(url, object, callback, context) {
  var name = urlname(url);
  if(isStreamName(name)) {
    var err = {};
    var input = inputUrl(url, object, context, err);
    if(input == null) {
      callback(err.code, null);
      return;
    }
    streamPost(url, input, function(code, ret) {
      if(code < 300)
        callback(code, outputUrl(url, ret, context));
      else
        callback(code, ret);
    });
  }
  else if(isFuncConstName(name))
    funcConstOp('post', url, object, callback, context);
  else {
    callback(405, null);
  }
}

exports.put = function(url, object, callback, context) {
  var name = urlname(url);
  if(isObjectName(name)) {
    var err = {};
    var input = inputUrl(url, object, context, err);
    if(input == null) {
      callback(err.code, null);
      return;
    }
    objectPut(url, input, function(code, ret) {
      if(code < 300)
        callback(code, outputUrl(url, ret, context));
      else
        callback(code, ret);
    });
  }
  else {
    callback(405, null);
  }
}

exports.delete= function(url, callback, context) {
  var name = urlname(url);
  if(isObjectName(name)) {
    objectDelete(url, context, function(code) {
        callback(code);
    });
  }
  else {
    callback(405, null);
  }
}
function etagForEntity(entity) {
    var modified = entity._modified;
    if(modified) 
      return '"' + modified.getTime() + '"';
    var slice = entity.slice;
    if(slice && isArray(slice)) {
      var sum = 0;
      for(var i in slice) {
        var e = slice[i];
	if(e._modified)
          sum += e._modified.getTime();
      }
      return '"' + sum + '"';
    }
    return null;
}
function ageForEntity(entity) {
  if(!entity['_id'] && entity['first'] && entity['last'] && 
      !entity['slice']) {
    return 360 * 24 * 60 * 60;
  }
  return 0; 
}
function doBefore(req, res, context, input, next, callback) {
  var name = urlname(req.url);
  var hook = beforeHooks[name];
  if(!hook) {
    next();
    return;
  }
  hook(req, context, input, next, callback);
}
function doAfter(req, res, context, code, entity, input, callback) {
  var name = urlname(req.url);
  var hook = afterHooks[name];
  if(!hook) {
    callback(code, entity);
    return;
  }
  hook(req, context, input, code, entity, 
    function() {
      callback(code, entity);
    },
    callback);
}
function contentGet(url, callback, context, n) {
  if(!n) n = 3;
  exports.xget(url, function(code, entity) {
    if(code < 300) {
      if(objectKeys(entity).length <= 3 && (entity.first || entity.last)) 
        exports.xget(entity.last + '&n=' + n, function(code, obj) {
          if(code < 300 && entity.count) {
            exports.xget(entity.count, function(code, co) {
              obj['@count'] = co.value;
              callback(code, obj);
            }, context);
          }
          else callback(code, obj);
        }, context);
      else
        callback(code, entity);
    }
    else
      callback(code, entity);
  }, context);
}
function embedObject(req, context, entity, config, callback) {
  var keys = objectKeys(config);
  async.forEach(keys, function(item, callback) {
    var rawitem = item;
    var itemN = item.split("~");
    item = itemN[0];
    var n = itemN[1];
    if(!entity[item]) {
      callback();
      return;
    }
    async.series([
      function(callback) {
        contentGet(entity[item], function(code, obj) {
          entity['#' + item] = code;
          if(obj) entity['@' + item] = obj;
          callback();
        }, context, n);
      },
      function(callback) {
        var obj = entity['@' + item];
        var cfg = config[rawitem];
        embed(req, context, obj, cfg, callback);
      }
    ], function(err) {
      callback();
    });

  }, callback);
}

function embedStream(req, context, entity, config, callback) {
  async.forEach(entity.slice, function(item, callback) {
    embedObject(req, context, item, config, callback) 
  }, callback);
}
function embed(req, context, entity, config, callback) {
  if(!config || !entity) 
    callback();
  else if((entity.first || entity.last) && isArray(entity.slice)) 
    embedStream(req, context, entity, config, callback) 
  else
    embedObject(req, context, entity, config, callback) 
}
function responseAfter(req, res, context, code, entity, input) {
      doAfter(req, res, context, code, entity, input, function(code, entity) {
        if(entity) {
          if(code < 400 && !req.ejXrequest) {
            var config = embeds[urlname(req.url)];
            if(!config) {
              config = embeds[urlentity(req.url)];
            }
            embed(req, context, entity, config, function() {
              res.writeHead(code, {'Content-Type': 'application/json'});
              res.end(JSON.stringify(entity));
            });
          }
          else {
            res.writeHead(code, {'Content-Type': 'application/json'});
            res.end(JSON.stringify(entity));
          }
        }
        else {
          res.writeHead(code);
          res.end();
        }
      }); 
}
function responseEntity(req, res, code, entity, input, context) {
    if(code == 201 && entity._self)
      res.setHeader('Location', entity._self);
    if(req.method == 'GET' || req.method == 'HEAD') {
      var etag = etagForEntity(entity);
      var ename = urlentity(req.url);
      if(etag && !embeds[ename]) {
        var ifnm = req.headers['if-none-match'];
        if(ifnm == etag) {
          res.writeHead(304);
          res.end();
          return;
        }
        res.setHeader('ETag', etag);
      }
      var origin = req.headers['origin'];
      var age = ageForEntity(entity);
      if(age != null)
        res.setHeader('Cache-Control', 'public,max-age=' + age);
    }
    responseAfter(req, res, context, code, entity, input); 
}
function response(req, res, code, entity, context, input, inctx) {
  if(context) {
    var expires = new Date();
    expires.setFullYear(expires.getFullYear() + 1);
    var c = new Cookies(req, res);
    var id = encodeJSON(context);
    c.set('extremejsSID', id, {expires: expires, httpOnly: false});

    res.setHeader('my-xsrf-header', id);
  }
  if(entity) {
    responseEntity(req, res, code, entity, input, inctx);
  }
  else {
    if(code >= 400)
      res.setHeader('Cache-Control', 'public,max-age=0');
    responseAfter(req, res, inctx, code, entity, input); 
  }
}
function contextForReq(req, res) {
  var c = new Cookies(req, res);
  var id = c.get('extremejsSID');
  var inctx = null;
  if(id) inctx = decodeJSON(id);
  else if(req.headers['authorization']) { // add by zakkzhang, 2015-1-6
    var token=req.headers['authorization'].split(/\s+/).pop();
    inctx = decodeJSON(token);
  }
  if(inctx == null) inctx = {};
  return inctx;
}

exports.context = contextForReq;

function processMethod(req, res, input, inctx) { 
  doBefore(req, res, inctx, input, 
      function() {
        _processMethod(req, res, input, inctx);
      },
      function(code, entity, context) {
        response(req, res, code, entity, context, input, inctx);
      });
}

function _processMethod(req, res, input, inctx) {
  if(input == null) input = {};
  var name = urlname(req.url);
  if(name == null) {
    response(req, res, 404);
  }
  else if(req.method == 'GET') {
    exports.get(req.url, function(code, entity, context) {
      response(req, res, code, entity, context, input, inctx);
    }, inctx);
  }
  else if(req.method == 'PUT') {
    exports.put(req.url, input, function(code, entity, context) {
      response(req, res, code, entity, context, input, inctx);
    }, inctx);
  }
  else if(req.method == 'PATCH') {
    exports.patch(req.url, input, function(code, entity, context) {
      response(req, res, code, entity, context, input, inctx);
    }, inctx);
  }
  else if(req.method == 'DELETE') {
    exports.delete(req.url, function(code, entity, context) {
      response(req, res, code, entity, context, input, inctx);
    }, inctx);
  }
  else if(req.method == 'POST') {
    exports.post(req.url, input, function(code, entity, context) {
      response(req, res, code, entity, context, input, inctx);
    }, inctx);
  }
  else if(req.method == 'OPTIONS') {
    res.writeHead(200);
    res.end();
  }
  else {
    res.writeHead(405);
    res.end();
  }
}
function setupAccessControl(req, res) {
  var origin = req.headers['origin'];
  if(origin == null)
    return;
  if(req.method == 'OPTIONS') {
    var requestHeader = req.headers['access-control-request-headers'];
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 
        'POST, GET, PUT, DELETE, OPTIONS, PATCH');
    if(requestHeader != null)
      res.setHeader('Access-Control-Allow-Headers', requestHeader);
    res.setHeader('Access-Control-Max-Age', 24 * 3600);
    res.setHeader('Access-Control-Allow-Credentials', true);
  }
  else {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Expose-Headers', 'my-xsrf-header');
  }
}

exports.httpfunc = function(req, res) {
  setupAccessControl(req, res);

  var input = null;
  var headers = req.headers;
  var contentType = headers['content-type'];
  var contentLen = headers['content-length'];
  req.url = 'http://' + headers['host'] + req.url;
  var inctx = contextForReq(req, res);
  if(contentType == null || contentLen == null || contentLen == 0){
    processMethod(req, res, null, inctx);
  }
  else if(contentType.indexOf('application/json')==0) {
    parseJSON(req, function(object) {
      if(object != null) {
        processMethod(req, res, object, inctx);
      }
      else {
        res.writeHead(400);
        res.end();
      }
    });
  }
  else {
	res.writeHead(415);
    res.end();
  }
}

exports.doc = function(name, d) {
  docs[name] = d;
}
exports.embed = function(name, e) {
  embeds[name] = e;
}
function doc(name) {
  var ret = docs[name] ? docs[name] : "";
  return '"' + ret + '"';
}
function linkDoc(name) {
  var ret = "";
  var r = resources[name];
  ret = doc(name);
  ret += ' type:' + r.entity;
  if(r.type == 'stream')
    ret += ' method:GET,POST,PATCH';
  else if(r.type == 'object') {
    if(r.edit)
      ret += ' method:GET,DELETE';
    else
      ret += ' method:GET,PUT,DELETE';
  }

  return ret;
}
exports.genDoc = function() {
  for(var name in resources) {
    var r = resources[name];
    if(r.type != 'entity' && r.type != 'const') continue;
    if(typeof(r.def) != 'object') continue;
    console.log('%s %s', name, doc(name));
    for(var p in r.def) {
      var def = r.def[p];
      if(isString(def))
        console.log('\t%s "%s"', p, def);
      else
        console.log('\t%s %s', p, linkDoc(def[0]));
    }
    console.log();
  }
}
