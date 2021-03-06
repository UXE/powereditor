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
    FB = require("../../lib/connect").FB,
    libUtils = require("../../lib/utils"),

    CampStat      = require("./campStat").CampStat,
    Changeable    = require("../lib/model/changeable").Changeable,
    Validatable   = require("../lib/model/validatable").Validatable,
    TabSeparated  = require("../lib/model/tabSeparated").TabSeparated,

    Account = require("./account").Account,
    Contract = require("./contract").Contract,
    Topline = require("./topline").Topline,
    env = require("../../uki-core/env"),
    campConst = require("./campaign/constants"),
    inflationConverter = require("../lib/budgetImpsConverter").Converter,

    rs = require("../lib/runStatus"),
    RoleChecker = require("../lib/adsUserRole").RoleChecker;

/**
* Campaign model
* @class
*/
var Campaign = storage.newStorage(Changeable, Validatable, TabSeparated, {
  init: function() {
    this._delivery_info = {
      'overdelivery_perc' : 0,
      'spent_perc'        : 0,
      'complete_perc'     : 0
    };
  },

  io_number: function() {
    if (this.line_number()) {
      return this.account().io_number();
    }
    return '';
  },

  allowedStatusTransitions: function() {
    if (this.isNew()) {

      if (RoleChecker.isDSOAdvertiser(this.account())) {
        return [rs.DRAFT];
      }
      return [rs.ACTIVE, rs.PAUSED];
    }

    var transitions = [];

    switch (this.original_status() || rs.ACTIVE) {
      case rs.ACTIVE:
        transitions = [rs.PAUSED, rs.DELETED];
        break;
      case rs.PAUSED:
        transitions = [rs.ACTIVE, rs.DELETED];
        break;
      case rs.DELETED:
        transitions = [];
        break;
      case rs.DRAFT:
        if (RoleChecker.canSetAliveDraft(this.account())) {
          transitions = [rs.ACTIVE, rs.PAUSED, rs.DELETED];
        } else {
          transitions = [rs.DELETED];
        }
        break;
      default:
        transitions = [rs.DELETED];
        break;
    }

    transitions.unshift(this.original_status() || rs.ACTIVE);
    return transitions;
  },

  toggleChildError: function(id, state) {
    var errors = (this.errors() || {});
    var e = errors.ads || { ids: {}, count: 0 };
    var oldState = !!e.ids[id];

    state = !!state;
    if (state !== oldState) {
      e.count += state ? 1 : -1;
      if (state) {
        e.ids[id] = true;
      } else {
        delete e.ids[id];
      }

      this.toggleError(e.count > 0, 'ads', utils.extend({}, e));
    }
  },

  toggleChildChanged: function(id, state) {
    var changes = (this.changes() || { ids: {}, count: 0 });
    var oldState = !!changes.ids[id];

    state = !!state;
    if (state !== oldState) {
      changes.count += state ? 1 : -1;
      if (state) {
        changes.ids[id] = true;
      } else {
        delete changes.ids[id];
      }

      this.changes(utils.extend({}, changes)).commitChanges('changes');
    }
  },

  commitChanges: function(name) {
    fun.deferOnce(this.store, this);
    this.validate(name);
  },

  isNew: function() {
    return this.id() < 0;
  },

  isChangedSelf: function(name) {
    if (!name && this.id() < 0) {
      return true;
    }
    return Changeable.isChanged.call(this, name);
  },

  isChanged: function(name) {
    if (name === undefined && this.changes() && this.changes().count > 0) {
      return true;
    }
    return this.isChangedSelf(name);
  },

  isFromTopline: function() {
    if (this.line_number() > 0 && this.line_id() > 0 && this.topline()) {
      return true;
    } else {
      return false;
    }
  },

  isImpressionBased: function() {
    return (!!this.daily_imps() || !!this.lifetime_imps());
  },

  isBudgetBased: function() {
    return (!!this.daily_budget() || !!this.lifetime_budget());
  },

  getLifeSpanInDays: function() {
    if (!!this.daily_imps() || !!this.daily_budget()) {
      if (this.isFromTopline()) {
        var start_time = this.original_start_time();
        var end_time = this.original_end_time();
        return (start_time - end_time) / 86400;
      }
    }
  },

  dataForRemoteCreate: function() {
    var store = this.dataForRemoteUpdate();
    delete store.campaign_id;
    return store;
  },

  dataForRemoteUpdate: function() {
    var store = {};
    this.storage().props().forEach(function(f) {
      if (f.remote) {
        var value = f.getRemoteValue(this);
        store[f.remote] = value;
      }
      }, this);

      fix.call(this, store);
      return store;
  },

  delivery_info: fun.newProp('delivery_info'),
  /**
   * Calculates delivery info for the this campaign.
   *
   * @returns obj with up to three keys:
   *    'overdelivery_perc': Percentage over or under the ideal
   *                         spent amount. (e.g. 50 = "50%")
   *    'spent_perc': Percentage of total budget spent for this campaign
   *    'complete_perc': Percentage complete in terms of duration
   */
  calculateDeliveryInfo: function() {
    var now = Date.now();

    var c_start = this.original_start_time() * 1000;
    var c_stop = this.original_end_time() * 1000;
    var perc_complete = 0;

    // calcuate the time pass percentage
    if (now < c_start) {
      perc_complete = 0;
    } else if (now > c_stop) {
      perc_complete = 1;
    } else {
      perc_complete =
        ((now - c_start) / (c_stop - c_start));
    }

    var camp_budget = this.original_total_budget();
    var camp_spent = this.stat() ? this.stat().spent() : 0;
    var camp_ideal_spent = camp_budget * perc_complete;

    var overdelivery_perc =
      (camp_ideal_spent !== 0) ? (camp_spent / camp_ideal_spent) - 1 : 0;

    var spent_perc = 0;
    if (camp_budget <= 0 && camp_spent > 0) {
      spent_perc = 'N/A (no budget)';
    } else if (camp_budget <= 0 && camp_spent === 0) {
      spent_perc = 0;
    } else {
      spent_perc = (camp_spent / camp_budget);
    }

    this.delivery_info().overdelivery_perc = overdelivery_perc;
    this.delivery_info().spent_perc = spent_perc;
    this.delivery_info().complete_perc = perc_complete;

    return this.delivery_info();
  },

  searchFields: function() {
    return [
     'name',
      'description',
      'io_name'
    ];
  },

  // this is the match function for campaign
  // here we decide what fields we can match
  match: function(query) {
    return getSearchIndex.call(this).indexOf(query) > -1;
  },

  camplink: fun.newProp('camplink'),

  graphCreatePath: function() {
    return '/act_' + this.account_id() + '/adcampaigns/';
  },

  graphUpdatePath: function() {
    return '/' + this.id() + '/';
  }
});

Campaign
  .defaultPropType(props.Base)
  .tableName('campaign')
  .resultSetType(require("./campaign/campResultSet").CampResultSet);

Campaign.addProp({
  type: props.LongNumber,
  prefix: 'c:',
  name: 'id',
  remote: 'campaign_id',
  indexed: 'TEXT NOT NULL PRIMARY KEY',
  tabSeparated: 'Campaign ID'
});

Campaign.addProp({
  type: props.LongNumber,
  name: 'account_id',
  indexed: "TEXT NOT NULL",
  db: true, remote: true
});

Campaign.addProp({
  name: 'account',
  getValue: function(obj) {
    return require("./account").Account.byId(obj.account_id());
  }
});

Campaign.addProp({
  type: props.CampaignStatus,
  name: 'campaign_status',
  db: true, remote: true,
  tabSeparated: ['Campaign Run Status', 'Campaign Status'],
  trackChanges: true
});

Campaign.addProp({
  name: 'original_status',
  getValue: function(obj) {
    return obj.original() &&
    obj.original().campaign_status || obj.campaign_status();
  }
});

Campaign.addProp({
  type: props.Number,
  name: 'budget_remaining',
  db: true, remote: true
});

Campaign.addProp({
  type: props.Number,
  name: 'original_budget_remaining',
  getValue: function(obj) {
    return obj.original() &&
    obj.original().budget_remaining || obj.budget_remaining();
  }
});

Campaign.addProp({
  type: props.Number,
  name: 'budget_remaining_100',
  getValue: function(obj) {
    return obj.budget_remaining() / 100;
  }
});

Campaign.addProp({
  type: props.Number,
  name: 'daily_budget',
  db: true, remote: true,
  trackChanges: true
});

Campaign.addProp({
  type: props.Number,
  name: 'original_daily_budget',
  getValue: function(obj) {
    return obj.original() &&
    obj.original().daily_budget || obj.daily_budget();
  }
});

Campaign.addProp({
  type: props.Number,
  name: 'daily_imps',
  db: true, remote: true,
  tabSeparated: ['Campaign Daily Impressions',
    'Daily Impressions', 'Daily Imps'],
  corpExportedOnly: true
});

Campaign.addProp({
  type: props.Number,
  name: 'original_daily_imps',
  getValue: function(obj) {
    return obj.original() &&
    obj.original().daily_imps || obj.daily_imps();
  }
});

Campaign.addProp({
  type: props.Number,
  name: 'lifetime_budget',
  db: true, remote: true,
  trackChanges: true
});

Campaign.addProp({
  type: props.Number,
  name: 'original_lifetime_budget',
  getValue: function(obj) {
    return obj.original() &&
    obj.original().lifetime_budget || obj.lifetime_budget();
  }
});

Campaign.addProp({
  type: props.Number,
  name: 'lifetime_imps',
  db: true, remote: true,
  tabSeparated: ['Campaign Lifetime Impressions',
    'Lifetime Impressions', 'Lifetime Imps'],
  corpExportedOnly: true
});

Campaign.addProp({
  type: props.Number,
  name: 'original_lifetime_imps',
  getValue: function(obj) {
    return obj.original() &&
    obj.original().lifetime_imps || obj.lifetime_imps();
  }
});

Campaign.addProp({
  name: 'name',
  db: true, remote: true,
  def: '',
  tabSeparated: 'Campaign Name',
  trackChanges: true,
  validate: function(obj) {
    obj.toggleError(
      !this.getValue(obj),
      'name',
      'Name of campaign is required'
    );
  }
});

// dates
Campaign.addProp({
  type: props.Timestamp,
  name: 'start_time',
  db: true,
  remote: true,
  trackChanges: true,
  tabSeparated: ['Campaign Time Start', 'Date Start'],
  validate: function(obj) {
    if (obj.isFromTopline()) {
      var start_time = obj.start_time().getTime();
      var error = start_time < obj.flight_start_date().getTime();
      obj.toggleError(
        error,
        'start_time',
        'Start time can not be eariler than the flight start time'
      );
    }
  }
});

Campaign.addProp({
  type: props.Timestamp,
  name: 'original_start_time',
  getValue: function(obj) {
    return obj.original() &&
    obj.original().start_time || obj.start_time();
  }
});

Campaign.addProp({
  type: props.Timestamp,
  name: 'end_time',
  db: true,
  remote: true,
  trackChanges: true,
  tabSeparated: ['Campaign Time Stop', 'Date Stop'],
  validate: function(obj) {
    if (obj.adjusted_flight_end_date()) {
      var end_time = obj.end_time().getTime();
      var is_past = end_time < (new Date()).getTime();
      var error = is_past ||
        (end_time > obj.adjusted_flight_end_date().getTime());
      obj.toggleError(
        error,
        'end_time',
        is_past ? 'Stop time can not be in the past'
          :'Stop time can not be later than the flight end time'
      );
    }
  }
});

Campaign.addProp({
  type: props.Timestamp,
  name: 'original_end_time',
  getValue: function(obj) {
    return obj.original() &&
    obj.original().end_time || obj.end_time();
  }
});

Campaign.addProp({
  type: props.Timestamp,
  name: 'time_updated',
  db: true,
  remote: true
});

Campaign.addProp({
  name: 'changes',
  db: true
});

Campaign.addProp({
  name: 'errors',
  db: true
});

Campaign.addProp({
  name: 'stat',
  def: new CampStat()
});

// budget
Campaign.addProp({
  name: 'uninflated_ui_budget_100',
  getValue: function(obj) {
    return inflationConverter.uninflateBudget(
      obj.budget_100(), obj.inflation());
  },
  setValue: function(obj, value) {
    var inflated_value = inflationConverter.
      inflateBudget(value, obj.inflation());
    obj.budget_100(inflated_value);
  }
});

Campaign.addProp({
  name: 'budget_100',
  getValue: function(obj) {
    return obj.budget_type() === 'd' ?
    obj.daily_budget() / 100 : obj.lifetime_budget() / 100;
  },
  setValue: function(obj, value) {
    if (obj.budget_type() === 'd') {
      obj.daily_budget(value * 100);
    } else {
      obj.lifetime_budget(value * 100);
    }
    // validate the budget status;
    if (obj.topline()) {
      obj.topline().validate('budget_status');
    }
  }
});

Campaign.addProp({
  type: props.Number,
  name: 'daily_budget_100',
  tabSeparated: ['Campaign Daily Budget', 'Daily Budget'],
  getValue: function(obj) {
    return obj.daily_budget() ? obj.daily_budget() / 100 : 0;
  },
  setValue: function(obj, value) {
    obj.daily_budget(value && value * 100);
  }
});

Campaign.addProp({
  type: props.Number,
  name: 'lifetime_budget_100',
  tabSeparated: ['Campaign Lifetime Budget', 'Lifetime Budget'],
  getValue: function(obj) {
    return obj.lifetime_budget() ? obj.lifetime_budget() / 100 : 0;
  },
  setValue: function(obj, value) {
    obj.lifetime_budget(value && value * 100);
  }
});

Campaign.addProp({
  name: 'budget_type',
  getValue: function(obj) {
    return obj.daily_budget() ? 'd' : 'l';
  },
  setValue: function(obj, value) {
    obj.daily_budget(value === 'd' ?
    (obj.daily_budget() * 1 || 1000) : '');
    obj.lifetime_budget(value === 'l' ?
    (obj.lifetime_budget() * 1 || 35000) : '');
  }
});

// imp
Campaign.addProp({
  name: 'imps',
  getValue: function(obj) {
    return obj.imps_type() === 'd' ?
    obj.daily_imps() : obj.lifetime_imps();
  },
  setValue: function(obj, value, source) {
    if (obj.imps_type() === 'd') {
      obj.daily_imps(value, source);
    } else {
      obj.lifetime_imps(value, source);
    }
  }
});

Campaign.addProp({
  name: 'imps_type',
  getValue: function(obj) {
    return obj.daily_imps() ? 'd' : 'l';
  },
  setValue: function(obj, value, source) {
    obj.daily_imps(value === 'd' ?
    (obj.daily_imps() * 1 || 100000) : '', source);
    obj.lifetime_imps(value === 'l' ?
    (obj.lifetime_imps() * 1 || 3500000) : '', source);
  }
});

Campaign.addProp({
  name: 'original',
  db: true
});

Campaign.addProp({
  name: 'line_number',
  db: true, remote: true,
  tabSeparated: 'Line Number',
  corpExportedOnly: true,
  trackChanges: true
});

Campaign.addProp({
  name: 'inflation',
  def: '0',
  db: true, remote: true,
  tabSeparated: 'Inflation',
  corpExportedOnly: true,
  trackChanges: true
});

Campaign.addProp({
  name: 'original_inflation',
  getValue: function(obj) {
    return obj.original() &&
    obj.original().inflation || obj.inflation();
  }
});

Campaign.addProp({
  name: 'line_id',
  db: true, remote: true
});

Campaign.addProp({
  name: 'external_bid',
  db: true, remote: true
});

Campaign.addProp({
  type: props.CampaignType,
  name: 'campaign_type',
  getValue: function(obj) {
    if (!obj._campaign_type) {
      if ((obj.lifetime_budget() != 0 && obj.lifetime_imps() != 0) ||
        (obj.daily_budget() != 0 && obj.daily_imps() != 0)) {
        return campConst.CAMP_MOO_TYPE;
      } else {
        return campConst.CAMP_CLASSIC_TYPE;
      }
    }
    return obj._campaign_type;
  }
});

Campaign.addProp({
  name: 'total_budget_100',
  getValue: function(obj) {
    if (obj.budget_type() === 'l') {
      return obj.lifetime_budget() / 100;
    }

    if (obj.end_time() && obj.start_time()) {
      var span =
        Math.ceil((obj._end_time - obj._start_time) / 86400);
      return (obj.daily_budget() * span) / 100;
    }
  }
});

Campaign.addProp({
  name: 'original_total_budget',
  getValue: function(obj) {
    if (obj.budget_type() === 'l') {
      return obj.original_lifetime_budget();
    }

    if (obj.original_end_time() && obj.original_start_time()) {
      var span = Math.ceil((obj.original_end_time() -
        obj.original_start_time()) / 86400
      );
      return (obj.original_daily_budget() * span);
    }
  }
});

Campaign.addProp({
  name: 'total_imps',
  getValue: function(obj) {
    if (obj.imps_type() === 'l') {
      return obj.lifetime_imps();
    }

    if (obj.end_time() && obj.start_time()) {
      var span =
        Math.ceil((obj._end_time - obj._start_time) / 86400);
      return obj.daily_imps() * span;
    }
  }
});

Campaign.addProp({
  name: 'contract',
  getValue: function(obj) {
    return Contract.byId(obj.account_id());
  }
});

Campaign.addProp({
  name: 'topline',
  def: new Topline(),
  getValue: function(obj) {
    return Topline.byId(obj.line_id());
  }
});

Campaign.addProp({
  name: 'spent_perc',
  getValue: function(obj) {
    if (obj.delivery_info()) {
      return obj.delivery_info().spent_perc;
    }
  }
});

Campaign.addProp({
  name: 'complete_perc',
  getValue: function(obj) {
    if (obj.delivery_info()) {
      return obj.delivery_info().complete_perc;
    }
  }
});

// make topline props accessable through campaign
fun.delegateProp(Campaign.prototype, [
    'product_type', 'ad_type',
    'flight_start_date', 'flight_end_date',
    'adjusted_flight_end_date',
    'uom', 'func_price',
    'func_line_amount', 'func_cap_amount',
    'description', 'targets'
], 'topline');

fun.delegateCall(Campaign.prototype,
    ['line_numbers', 'isCorporate'], 'account');

fun.delegateProp(Campaign.prototype, 'line_impressions',
  'topline', 'impressions');

// make contract props accessable through campaign
fun.delegateProp(Campaign.prototype, 'io_number', 'contract');
fun.delegateProp(Campaign.prototype, 'io_name', 'contract', 'name');

// make stat props accessable through campaign
fun.delegateProp(Campaign.prototype, [
    'impressions', 'clicks', 'spent', 'social_impressions',
    'social_clicks', 'social_spent', 'spent_100', 'last_update_time'
], 'stat');

fun.delegateProp(Campaign.prototype, 'social_connections',
  'stat', 'connections');

function fix(store) {
  delete store.budget_remaining;
  ['daily_budget', 'end_time', 'lifetime_budget'].forEach(function(name) {
    if (store[name]*1 == 0) {
      delete store[name];
    }
  });

  // patch the impression number for dso campaigns.
  delete store.lifetime_imps;
  delete store.daily_imps;
  if (store.line_number) {

    store.io_number = this.io_number();
    var func_price = this.func_price();
    if (func_price) {
      if (this.campaign_type() == campConst.CAMP_MOO_TYPE) {
        if (store.daily_budget) {
          store.daily_imps =
            inflationConverter
              .convertToImps(store.daily_budget, func_price);
        }
        if (store.lifetime_budget) {
          store.lifetime_imps =
            inflationConverter
              .convertToImps(store.lifetime_budget, func_price);
        }
      }
    }

    // set the external_bid to be the line price.
    store.external_bid = func_price ?
      func_price * 100 : 0;
  }
}

function getSearchIndex() {
  var indexes =  this.searchFields().map(fun.bind(
      function(prop) {
        return this[prop]();
      }, this))
    .join(' ').toLowerCase();

  return indexes;
}

Campaign.remove = function(callback) {
  var item = this;
  require("./ad").Ad.deleteBy('campaign_id', this.id(), function() {
    storage.Storable.remove.call(item, callback);
  });
};

Campaign.cache = null;

Campaign.byId = function(id) {
  return Campaign.cache && Campaign.cache.byId(id);
};

// --- Syncing with Graph API stuff ---

Campaign.loadFromAccountIds = function(account_ids, callback) {
  if (!account_ids.length) {
    callback([], true);
    return;
  }
  var paths = libUtils.wrapArray(account_ids).map(
    function(account_id) {
      return pathUtils.join('act_' + account_id, '/adcampaigns');
    }
  );
  Campaign.fetchAndStoreEdges(paths, callback);
};

Campaign.createFromRemote = function(data) {
  var camp = storage.Storage.createFromRemote.call(this, data);
  camp.initChangeable();
  return camp;
};

// --- END Syncing with Graph API stuff ---

Campaign.prepare = function(callback, force) {
  if (!force && this.cache) {
    callback(this.cache);
    return;
  }
  this.findAll(function(camps) {
    camps.prefetch();
    Campaign.cache = camps;
    callback(camps);
  });
};

Campaign.create = function(parent, lineNumber) {
  var account_id =
    parent.account_id ? parent.account_id() : parent.id();

  var line_id = null;
  var topline = null;
  if (parent instanceof Account) {
    // attach to the first topline if
    // we do not provide a lineNumber
    var contract = Contract.byId(account_id);
    if (contract && contract.children().length) {
      if (lineNumber) {
        line_id = contract.children().filter(function(line) {
          return line.line_number() == lineNumber; })[0]
        .id();
      } else {
        line_id = contract.children()[0].id();
      }
    }
  } else if (parent instanceof Campaign) {
    if (parent.isFromTopline()) {
      // attach to the current topline of this selected campaign
      line_id = parent.line_id();
    }
  }

  if (line_id) {
    topline = Topline.byId(line_id);

    if (topline.adjusted_flight_end_date() < new Date()) {
      alert('Can not create campaigns for an ended topline');
      return '';
    }
  }

  var camp = new Campaign(),
    ds = new Date(),
    de = new Date();
  de.setTime(0);

  if (topline) {
   ds = topline.flight_start_date() > ds ?
     topline.flight_start_date() : ds;

   de = topline.adjusted_flight_end_date();
   // dso contract/topline specific field
   camp.line_id(line_id);
   camp.line_number(topline.line_number());
   camp.io_number(topline.contract().io_number());
  }

  // negative id => ad is new
  camp.id(- new Date() - (env.guid++))
    // $10 hardcoded
    .daily_budget(1000)
    // we should have account here
    .account_id(account_id)
    // active
    .campaign_status(1)
    .start_time(ds)
    .end_time(de);

  return camp;
};

Campaign.copyLocalProps = function(oldCamp, newCamp) {
  oldCamp.storage().props().forEach(function(p) {
    if (p.persistable) {
      newCamp[p.name](oldCamp[p.name]());
    }
  });
};

exports.Campaign = Campaign;
