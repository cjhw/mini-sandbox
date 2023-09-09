class Sandbox {
  #options = {};
  deletedPropertiesSet = new Set();
  listenerMap;
  evt;
  winProxy;
  fetchProxy;
  setTimeoutProxy;
  localStorageProxy;
  requestAnimationFrameProxy;
  requestIdleCallbackProxy;
  constructor(options) {
    this.initCommonProxy();
    this.initFetchProxy();
    this.initLocalStorageProxy();
    const evt = new EventTarget();
    const listenerMap = new Map();
    function addEventListener(eventName, listener, options) {
      if (listenerMap.has(eventName)) {
        const listenerFnSet = listenerMap.get(eventName);

        listenerFnSet.add(listener);
      } else {
        const listenerFnSet = new Set();
        listenerMap.set(eventName, listenerFnSet);

        listenerFnSet.add(listener);
      }
      return evt.addEventListener(eventName, listener, options);
    }

    function removeEventListener(eventName, listener, options) {
      if (listenerMap.has(eventName)) {
        const listenerFnSet = listenerMap.get(eventName);

        listenerFnSet.remove(listener);

        if (!listenerFnSet.size) listenerMap.delete(eventName);
      }

      return evt.removeEventListener(eventName, listener, options);
    }

    function dispatchEvent(eventName) {
      return evt.dispatchEvent(eventName);
    }
    this.listenerMap = listenerMap;
    this.evt = evt;

    this.#options = Object.freeze({
      escapeVariables: [],
      escapeWEvents: [],
      presetVariables: {
        addEventListener,
        removeEventListener,
        dispatchEvent,
      },
      patches: {
        setTimeout: false,
        localStorage: false,
        fetch: false,
      },
      ...options,
    });
    const target = Object.assign(
      Object.create(null),
      this.#options.presetVariables
    );
    new Proxy(target, {});
    this.winProxy = this.initWinProxy(target);
  }

  prepareProperty(target, p) {
    if (Object.hasOwn(window, p) && !Object.hasOwn(target, p)) {
      const desc = Refect.getOwnPropertyDescriptor(window, p);
      Reflect.defineProperty(target, p, {
        value: "get" in desc ? Reflect.get(window, p) : undefined,
        writable: "set" in desc,
        enumerable: desc.enumerable,
        configurable: desc.configurable,
      });
    }
  }

  initWinProxy(target) {
    const escapeVariables = this.#options.escapeVariables;
    const deletedPropertiesSet = this.deletedPropertiesSet;
    const winProxy = new Proxy(target, {
      defineProperty(target, p, attributes) {
        console.log("defineProperty", target, p, attributes);
        this.prepareProperty(target, p);
        // 变量逃逸
        if (escapeVariables.includes(p)) {
          Reflect.defineProperty(target, p, attributes);
          return Reflect.defineProperty(window, p, attributes);
        }

        // 无论是否存在，直接尝试删除
        deletedPropertiesSet.delete(p);

        return Reflect.defineProperty(target, p, attributes);
      },

      deleteProperty(target, p) {
        this.prepareProperty(target, p);

        // 变量逃逸
        if (escapeVariables.includes(p)) {
          Reflect.deleteProperty(window, p, attributes);
        }

        const result = Reflect.deleteProperty(target, p, attributes);

        if (result) {
          deletedPropertiesSet.add(p);
        }

        return result;
      },

      get(target, p, receiver) {
        // 变量逃逸
        if (escapeVariables.includes(p)) {
          return Reflect.get(window, p, receiver);
        }
        // 是否是已经删除的属性

        if (deletedPropertiesSet.has(p)) {
          return undefined;
        }
        if (Reflect.has(target, p)) {
          // 由于没有原型，这里等价于 Object.hasOwn(target, p)
          return Reflect.get(target, p, receiver);
        }

        // target 没有的属性，从 window 上取
        const valueInWin = Reflect.get(window, p, receiver);

        // 函数需要特殊处理
        if ("function" === typeof valueInWin) {
          // 大写字母开头的函数认为是构造函数，不必处理
          if ("string" === typeof p && /^[A-Z]/.test(p)) {
            return valueInWin;
          }
          // 个别对上下文无感的函数也不必处理
          if (
            "string" === typeof p &&
            [
              "parseInt",
              "parseFloat",
              "isNaN",
              "isFinite",
              "encodeURIComponent",
              "escape",
            ].includes(p)
          ) {
            return valueInWin;
          }

          // 封装
          const newFn = function (...args) {
            // 万一也当作构造函数
            if (new.target) {
              return Reflect.construct(valueInWin, args);
            }
            return Reflect.apply(valueInWin, window, args);
          };

          // 修正函数的name和length属性
          Object.defineProperties(newFn, {
            length: {
              // 覆写
              value: valueInWin.length,
              writable: false,
              enumerable: false,
              configurable: true,
            },
            name: {
              // 覆写
              value: valueInWin.name,
              writable: false,
              enumerable: false,
              configurable: true,
            },
          });

          return newFn;
        }

        return valueInWin;
      },
    });

    return winProxy;
  }

  initFetchProxy() {
    // 记录所有的 AbortController
    const abortControllers = [];

    // 存储 AbortController
    const pushAbortController = (ac) => {
      abortControllers.push(ac);
    };

    // 移除 AbortController
    const removeAbortController = (ac) => {
      const idx = abortControllers.findIndex((nid) => nid === ac);
      if (idx >= 0) {
        abortControllers.splice(idx, 1);
      }
    };

    // 此函数注入到 presetVariables 中
    function fetchProxy(input, init) {
      if (!init?.signal) {
        const ac = new AbortController();
        let ret;

        if (init) {
          init.signal = ac.signal;
          ret = fetch(input, init);
        } else {
          ret = fetch(input, {
            signal: ac.signal,
          });
        }

        pushAbortController(ac);

        return ret.finally(() => removeAbortController(ac));
      }

      return fetch(input, init);
    }

    this.fetchProxy = fetchProxy;
  }

  initCommonProxy() {
    function fnProxy(createfn, rets) {
      return function (...args) {
        const ret = createfn(...args);
        rets.push(ret);
        return ret;
      };
    }

    const timeouts = [];
    this.setTimeoutProxy = fnProxy(setTimeout, timeouts);

    const intervals = [];
    this.setIntervalProxy = fnProxy(setInterval, intervals);

    const rafs = [];
    this.requestAnimationFrameProxy = fnProxy(requestAnimationFrame, rafs);

    const rics = [];
    this.requestIdleCallbackProxy = fnProxy(requestIdleCallback, rics);
  }

  initLocalStorageProxy() {
    this.initLocalStorageProxy = {
      getItem(key) {
        return localStorage.getItem(KEY_PREFIX + key);
      },
      setItem(key, val) {
        return localStorage.setItem(KEY_PREFIX + key, val);
      },
      removeItem(key) {
        return localStorage.removeItem(KEY_PREFIX + key);
      },
    };
  }

  runScript(code) {
    console.log(`function(window, globalThis, self, document, localStorage, setTimeout) {
      ${this.#options.strict ? '"use strict";' : ""}
      ${code}
  }`);
    const fn = (0,
    eval)(`(() => function(window, globalThis, self, localStorage, setTimeout) {
        ${this.#options.strict ? '"use strict";' : ""}
        ${code}
    })()`);

    return fn.apply(this.#options.strict ? undefined : this.winProxy, [
      this.winProxy /* window */,
      this.winProxy /* globalThis */,
      this.winProxy /* self */,
      this.localStorageProxy /* localStorage */,
      this.setTimeoutProxy /* setTimeout */,
    ]);
  }

  dispose() {
    for (const [eventName, eventSet] of this.listenerMap) {
      for (const lis of eventSet) {
        this.evt /*如果不需要区域化事件，这里就是 window*/
          .removeEventListener(eventName, lis);
      }
    }

    // 其他的卸载 todo
  }
}

const sandbox = new Sandbox();
window.aa = 1;
window.sandbox = sandbox;
window.winProxy = sandbox.winProxy;
