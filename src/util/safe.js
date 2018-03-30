import isDataDescriptor from "./is-data-descriptor.js"
import isObject from "./is-object.js"
import isObjectLike from "./is-object-like.js"
import keysAll from "./keys-all.js"

function safe(Super) {
  if (typeof Super !== "function") {
    return isObject(Super)
      ? copy({ __proto__: null }, Super)
      : Super
  }

  const Safe = isObjectLike(Super.prototype)
    ? class extends Super {}
    : (...args) => Reflect.construct(Super, args)

  const names = keysAll(Super)
  const safeProto = Safe.prototype

  for (const name of names) {
    if (name !== "prototype") {
      copyProperty(Safe, Super, name)
    }
  }

  copy(safeProto, Super.prototype)
  Reflect.setPrototypeOf(safeProto, null)

  return Safe
}

function copy(object, source) {
  const names = keysAll(source)

  for (const name of names) {
    copyProperty(object, source, name)
  }

  return object
}

function copyProperty(object, source, key) {
  const descriptor = Reflect.getOwnPropertyDescriptor(source, key)

  if (descriptor) {
    if (isDataDescriptor(descriptor)) {
      object[key] = source[key]
    } else {
      if (Reflect.has(descriptor, "writable")) {
        descriptor.writable = true
      }

      Reflect.defineProperty(object, key, descriptor)
    }
  }

  return object
}

export default safe
