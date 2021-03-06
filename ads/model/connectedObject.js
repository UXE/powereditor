/**
* Copyright 2011 Facebook, Inc.
*
* You are hereby granted a non-exclusive, worldwide, royalty-free license to
* use, copy, modify, and distribute this software in source code or binary
* form for use in connection with the web services and APIs provided by
* Facebook.
*
* As with any software that integrates with the Facebook platform, your use
* of this software is subject to the Facebook Developer Principles and
* Policies [http://developers.facebook.com/policy/]. This copyright notice
* shall be included in all copies or substantial portions of the software.
*
* THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
* IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
* FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL
* THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
* LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
* FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
* DEALINGS IN THE SOFTWARE.
*
*
*/

var fun   = require("../../uki-core/function"),
    utils = require("../../uki-core/utils"),

    storage = require("../../storage/storage"),
    pathUtils = require("../../lib/pathUtils"),

    props   = require("../lib/props"),

    Util = require("../../uki-fb/view/typeahead/util").Util,

    libUtils = require("../../lib/utils");

/**
* Facebook content you own
* @class
*/
var ConnectedObject = storage.newStorage({
  typeName: function() {
      return TYPE_NAMES[this.type()];
  },

  defaultCreativeType: function(is_bass, is_premium) {
      return require("../lib/adCreativeType")
        .getDefaultCreativeTypeByAnchor(this.type(), is_bass, is_premium);
  },

  tabList: function() {
    var list = [{ text: 'Default', value: this.url() }];
    utils.forEach(this.tabs() || {}, function(text, url) {
      list.push({ text: text, value: url });
    });
    return list;
  }
});

ConnectedObject
  .defaultPropType(props.Base)
  .tableName('connected_object');

ConnectedObject.addProp({
  name: 'id',
  type: props.LongNumber,
  remote: true,
  indexed: 'TEXT NOT NULL PRIMARY KEY'
});

ConnectedObject.addProp({
  name: 'name',
  remote: true, db: true
});

ConnectedObject.addProp({
  name: 'type',
  remote: true, db: true
});

ConnectedObject.addProp({
  name: 'url',
  remote: true, db: true
});

ConnectedObject.addProp({
  name: 'tabs',
  remote: true, db: true
});

ConnectedObject.addProp({
  name: 'is_extra_object',
  db: true,
  def: false
});


var TYPE_NAMES = {
  // external webpage is not a real obj type
  'external_webpage' : 'External Webpage',
  1: 'Facebook Page',
  2: 'Application',
  3: 'Events',
  4: 'Groups',
  5: 'Review',
  6: 'Places',
  7: 'Domain'
};

var OBJECT_TYPE = {
  EXTERNAL_WEBPAGE : 'external_webpage',
  PAGE: 1,
  APP: 2,
  EVENT: 3,
  GROUP: 4,
  REVIEW: 5,
  PLACE: 6,
  DOMAIN: 7
};

ConnectedObject.search = function(query, limit, exclusions) {
  limit = limit || 10;
  exclusions = exclusions || [];
  query = (' ' + query).toLowerCase();
  var d = this.cachedObjects();

  for (var r = [], l = d.length, i = 0, item; i < l && limit > 0; i++) {
    item = d[i];
    // generate search index
    item._si = item._si ||
    (' ' + Util.tokenize(item.name() || '').join(' '));
    if (item._si.indexOf(query) > -1 &&
    exclusions.indexOf(item.id()) === -1) {

      r.push({
        id: item.id(),
        text: item.name(),
        subtext: item.typeName()
      });
      limit--;
    }
  }
  return r;
};

ConnectedObject.cachedObjects = function() {
  return this._cache;
};

ConnectedObject.byId = function(id) {
  return this._cacheMap[id];
};

ConnectedObject.prepare = function(callback, force) {
  if (!force && this._cache) {
    callback(this._cache);
    return;
  }
  this.findAll(fun.bind(function(objects) {
    this._cache = objects;
    this._cacheMap = {};
    objects.forEach(function(o) {
      this._cacheMap[o.id()] = o;
    }, this);
    callback(this._cache);
  }, this));
};

// --- Syncing with Graph API stuff ---

ConnectedObject.loadFromAccountIds = function(account_ids, callback) {
  if (!account_ids.length) {
    callback([], true);
    return;
  }
  var paths = ['/act_' + account_ids[0] + '/connectionobjects'];
  // clear caches
  this._cache = this._cacheMap = null;
  ConnectedObject.fetchAndStoreEdges(paths, callback);
};

// --- END Syncing with Graph API stuff ---

exports.TYPE_NAMES = TYPE_NAMES;
exports.OBJECT_TYPE = OBJECT_TYPE;
exports.ConnectedObject = ConnectedObject;
