#if defined(__linux__)
#define _GNU_SOURCE
#endif

#include <errno.h>
#include <node_api.h>
#include <string.h>
#include <sys/socket.h>

#if defined(__APPLE__)
#include <fcntl.h>
#include <sys/param.h>
#include <sys/un.h>
#endif

static napi_value get_peer_uid(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  int32_t descriptor;

  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 1) {
    napi_throw_type_error(env, NULL, "getPeerUid requires one socket descriptor");
    return NULL;
  }
  if (napi_get_value_int32(env, argv[0], &descriptor) != napi_ok || descriptor < 0) {
    napi_throw_type_error(env, NULL, "Socket descriptor must be a non-negative integer");
    return NULL;
  }

#if defined(__APPLE__)
  uid_t peer_uid;
  gid_t peer_gid;
  int result;
  do {
    result = getpeereid(descriptor, &peer_uid, &peer_gid);
  } while (result != 0 && errno == EINTR);
  if (result != 0) {
    napi_throw_error(env, NULL, strerror(errno));
    return NULL;
  }
#else
  struct ucred credentials;
  socklen_t length;
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
    napi_throw_error(env, NULL, "Peer credentials had an unexpected size");
    return NULL;
  }
  uid_t peer_uid = credentials.uid;
#endif

  napi_value uid;
  if (napi_create_uint32(env, peer_uid, &uid) != napi_ok) {
    napi_throw_error(env, NULL, "Could not return the peer uid");
    return NULL;
  }
  return uid;
}

#if defined(__APPLE__)
/* Linux resolves open descriptors through /proc/self/fd; Darwin uses F_GETPATH
 * so an open document can follow an external rename (mac-plan §4.2). */
static napi_value get_path_for_fd(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  int32_t descriptor;
  char path[MAXPATHLEN];

  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 1) {
    napi_throw_type_error(env, NULL, "getPathForFd requires one file descriptor");
    return NULL;
  }
  if (napi_get_value_int32(env, argv[0], &descriptor) != napi_ok || descriptor < 0) {
    napi_throw_type_error(env, NULL, "File descriptor must be a non-negative integer");
    return NULL;
  }

  int result;
  do {
    result = fcntl(descriptor, F_GETPATH, path);
  } while (result == -1 && errno == EINTR);
  if (result == -1) {
    napi_throw_error(env, NULL, strerror(errno));
    return NULL;
  }

  napi_value value;
  if (napi_create_string_utf8(env, path, NAPI_AUTO_LENGTH, &value) != napi_ok) {
    napi_throw_error(env, NULL, "Could not return the descriptor path");
    return NULL;
  }
  return value;
}
#endif

static napi_value initialize(napi_env env, napi_value exports) {
  napi_value function;
  if (napi_create_function(env, "getPeerUid", NAPI_AUTO_LENGTH, get_peer_uid, NULL, &function) != napi_ok ||
      napi_set_named_property(env, exports, "getPeerUid", function) != napi_ok) {
    napi_throw_error(env, NULL, "Could not export getPeerUid");
    return NULL;
  }
#if defined(__APPLE__)
  if (napi_create_function(env, "getPathForFd", NAPI_AUTO_LENGTH, get_path_for_fd, NULL, &function) != napi_ok ||
      napi_set_named_property(env, exports, "getPathForFd", function) != napi_ok) {
    napi_throw_error(env, NULL, "Could not export getPathForFd");
    return NULL;
  }
#endif
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
