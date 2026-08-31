#define _GNU_SOURCE

#include <errno.h>
#include <node_api.h>
#include <string.h>
#include <sys/socket.h>

static napi_value get_peer_uid(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  int32_t descriptor;
  struct ucred credentials;
  socklen_t length = sizeof(credentials);

  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 1) {
    napi_throw_type_error(env, NULL, "getPeerUid requires one socket descriptor");
    return NULL;
  }
  if (napi_get_value_int32(env, argv[0], &descriptor) != napi_ok || descriptor < 0) {
    napi_throw_type_error(env, NULL, "Socket descriptor must be a non-negative integer");
    return NULL;
  }
  int result;
  do {
    length = sizeof(credentials);
    result = getsockopt(descriptor, SOL_SOCKET, SO_PEERCRED, &credentials, &length);
  } while (result != 0 && errno == EINTR);
  if (result != 0) {
    napi_throw_error(env, NULL, strerror(errno));
    return NULL;
  }
  if (length != sizeof(credentials)) {
    napi_throw_error(env, NULL, "SO_PEERCRED returned an unexpected credential size");
    return NULL;
  }

  napi_value uid;
  if (napi_create_uint32(env, credentials.uid, &uid) != napi_ok) {
    napi_throw_error(env, NULL, "Could not return the peer uid");
    return NULL;
  }
  return uid;
}

static napi_value initialize(napi_env env, napi_value exports) {
  napi_value function;
  if (napi_create_function(env, "getPeerUid", NAPI_AUTO_LENGTH, get_peer_uid, NULL, &function) != napi_ok) {
    napi_throw_error(env, NULL, "Could not create getPeerUid");
    return NULL;
  }
  if (napi_set_named_property(env, exports, "getPeerUid", function) != napi_ok) {
    napi_throw_error(env, NULL, "Could not export getPeerUid");
    return NULL;
  }
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
