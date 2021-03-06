'use strict';

const jose = require('node-jose');
const assert = require('assert');
const util = require('util');
const url = require('url');
const _ = require('lodash');
const LRU = require('lru-cache');
const got = require('got');

const DEFAULT_HTTP_OPTIONS = require('./consts').DEFAULT_HTTP_OPTIONS;
const ISSUER_DEFAULTS = require('./consts').ISSUER_DEFAULTS;
const ISSUER_METADATA = require('./consts').ISSUER_METADATA;
const DISCOVERY = require('./consts').DISCOVERY;
const WEBFINGER = require('./consts').WEBFINGER;
const REL = require('./consts').REL;

const errorHandler = require('./error_handler');
const BaseClient = require('./client');
const registry = require('./issuer_registry');
const expectResponse = require('./expect_response');
const webfingerNormalize = require('./webfinger_normalize');

const privateProps = new WeakMap();

let defaultHttpOptions = _.clone(DEFAULT_HTTP_OPTIONS);

function instance(ctx) {
  if (!privateProps.has(ctx)) privateProps.set(ctx, {});
  return privateProps.get(ctx);
}

function stripTrailingSlash(uri) {
  if (uri && uri.endsWith('/')) {
    return uri.slice(0, -1);
  }
  return uri;
}

class Issuer {
  /**
   * @name constructor
   * @api public
   */
  constructor(metadata) {
    const recognized = _.chain(metadata)
      .pick(ISSUER_METADATA)
      .defaults(ISSUER_DEFAULTS)
      .value();

    if (!recognized.introspection_endpoint && recognized.token_introspection_endpoint) {
      recognized.introspection_endpoint = recognized.token_introspection_endpoint;
    }

    if (!recognized.revocation_endpoint && recognized.token_revocation_endpoint) {
      recognized.revocation_endpoint = recognized.token_revocation_endpoint;
    }

    _.forEach(recognized, (value, key) => { instance(this)[key] = value; });

    instance(this).cache = new LRU({ max: 100 });

    registry.set(this.issuer, this);

    const self = this;

    Object.defineProperty(this, 'Client', {
      value: class Client extends BaseClient {
        static get issuer() {
          return self;
        }

        get issuer() {
          return this.constructor.issuer;
        }
      },
    });
  }

  /**
   * @name inspect
   * @api public
   */
  inspect() {
    return util.format('Issuer <%s>', this.issuer);
  }

  /**
   * @name keystore
   * @api private
   */
  keystore(reload) {
    if (!this.jwks_uri) return Promise.reject(new Error('jwks_uri must be configured'));

    const keystore = instance(this).keystore;
    const lookupCache = instance(this).cache;

    if (reload || !keystore) {
      lookupCache.reset();
      return got(this.jwks_uri, this.httpOptions())
        .then(expectResponse(200))
        .then(response => JSON.parse(response.body))
        .then(jwks => jose.JWK.asKeyStore(jwks))
        .then((joseKeyStore) => {
          lookupCache.set('throttle', true, 60 * 1000);
          instance(this).keystore = joseKeyStore;
          return joseKeyStore;
        })
        .catch(errorHandler);
    }

    return Promise.resolve(keystore);
  }

  /**
   * @name key
   * @api private
   */
  key(def, allowMulti) {
    const lookupCache = instance(this).cache;

    // refresh keystore on every unknown key but also only upto once every minute
    const freshJwksUri = lookupCache.get(def) || lookupCache.get('throttle');

    return this.keystore(!freshJwksUri)
      .then(store => store.all(def))
      .then((keys) => {
        assert(keys.length, 'no valid key found');
        if (!allowMulti) {
          assert.equal(keys.length, 1, 'multiple matching keys, kid must be provided');
          lookupCache.set(def, true);
        }
        return keys[0];
      });
  }

  /**
   * @name metadata
   * @api public
   */
  get metadata() {
    return _.omitBy(_.pick(this, ISSUER_METADATA), _.isUndefined);
  }

  /**
   * @name webfinger
   * @api public
   */
  static webfinger(input) {
    const resource = webfingerNormalize(input);
    const host = url.parse(resource).host;
    const query = { resource, rel: REL };
    const opts = { query, followRedirect: true };
    const webfingerUrl = `https://${host}${WEBFINGER}`;

    return got(webfingerUrl, this.httpOptions(opts))
      .then(expectResponse(200))
      .then(response => JSON.parse(response.body))
      .then((body) => {
        const location = _.find(body.links, link => typeof link === 'object' && link.rel === REL && link.href);
        assert(location, 'no issuer found in webfinger');
        assert(typeof location.href === 'string' && location.href.startsWith('https://'), 'invalid issuer location');
        const expectedIssuer = location.href;
        if (registry.has(expectedIssuer)) return registry.get(expectedIssuer);

        return this.discover(expectedIssuer).then((issuer) => {
          try {
            assert.equal(issuer.issuer, expectedIssuer, 'discovered issuer mismatch');
          } catch (err) {
            registry.delete(issuer.issuer);
            throw err;
          }
          return issuer;
        });
      });
  }

  /**
   * @name discover
   * @api public
   */
  static discover(uri) {
    uri = stripTrailingSlash(uri); // eslint-disable-line no-param-reassign
    const isWellKnown = uri.endsWith(DISCOVERY);
    const wellKnownUri = isWellKnown ? uri : `${uri}${DISCOVERY}`;

    return got(wellKnownUri, this.httpOptions())
      .then(expectResponse(200))
      .then(response => new this(JSON.parse(response.body)))
      .catch(errorHandler);
  }

  /**
   * @name httpOptions
   * @api public
   */
  httpOptions() {
    return this.constructor.httpOptions.apply(this.constructor, arguments); // eslint-disable-line prefer-rest-params, max-len
  }

  /**
   * @name httpOptions
   * @api public
   */
  static httpOptions(values) {
    return _.merge({}, this.defaultHttpOptions, values);
  }

  /**
   * @name defaultHttpOptions
   * @api public
   */
  static get defaultHttpOptions() {
    return defaultHttpOptions;
  }

  /**
   * @name defaultHttpOptions=
   * @api public
   */
  static set defaultHttpOptions(value) {
    defaultHttpOptions = _.merge({}, DEFAULT_HTTP_OPTIONS, value);
  }

}

ISSUER_METADATA.forEach((prop) => {
  Object.defineProperty(Issuer.prototype, prop, {
    get() {
      return instance(this)[prop];
    },
  });
});

module.exports = Issuer;
