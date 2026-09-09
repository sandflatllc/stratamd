#if defined(__linux__)
#define _GNU_SOURCE
#endif

#include <node_api.h>
#include <errno.h>
#include <string.h>
#if defined(_WIN32)
#include <windows.h>
#include <io.h>
#include <stdio.h>
#else
#include <sys/file.h>
#endif

#if defined(__APPLE__)
#include <errno.h>
#include <fcntl.h>
#include <string.h>
#include <sys/param.h>
#include <sys/un.h>
#include <unistd.h>
#endif

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

/* flock is tied to the open descriptor and released by the kernel on death. */
static napi_value try_lock(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1], value;
  int32_t fd;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 1 ||
      napi_get_value_int32(env, argv[0], &fd) != napi_ok || fd < 0) {
    napi_throw_type_error(env, NULL, "tryLock requires a file descriptor"); return NULL;
  }
#if defined(_WIN32)
  OVERLAPPED overlapped = {0};
  BOOL locked = LockFileEx((HANDLE)_get_osfhandle(fd), LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &overlapped);
  if (!locked && GetLastError() != ERROR_LOCK_VIOLATION) {
    napi_throw_error(env, NULL, "LockFileEx failed"); return NULL;
  }
  napi_get_boolean(env, locked != 0, &value);
#else
  int result;
  do { result = flock(fd, LOCK_EX | LOCK_NB); } while (result == -1 && errno == EINTR);
  if (result == -1 && errno != EWOULDBLOCK && errno != EAGAIN) {
    napi_throw_error(env, NULL, strerror(errno)); return NULL;
  }
  napi_get_boolean(env, result == 0, &value);
#endif
  return value;
}

#if defined(_WIN32)
static napi_value get_path_for_fd(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1], value;
  int32_t fd;
  wchar_t path[32768];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 1 ||
      napi_get_value_int32(env, argv[0], &fd) != napi_ok || fd < 0) {
    napi_throw_type_error(env, NULL, "getPathForFd requires a file descriptor"); return NULL;
  }
  DWORD length = GetFinalPathNameByHandleW((HANDLE)_get_osfhandle(fd), path, 32768, FILE_NAME_NORMALIZED);
  if (!length || length >= 32768) {
    napi_throw_error(env, NULL, "GetFinalPathNameByHandleW failed"); return NULL;
  }
  napi_create_string_utf16(env, (const char16_t *)path, length, &value);
  return value;
}
#endif

#if defined(_WIN32)
static napi_value process_info(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1], value, start, executable;
  uint32_t pid;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 1 ||
      napi_get_value_uint32(env, argv[0], &pid) != napi_ok || pid == 0) {
    napi_throw_type_error(env, NULL, "processInfo requires a positive PID"); return NULL;
  }
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  FILETIME created, exited, kernel, user;
  wchar_t path[32768];
  DWORD length = 32768;
  if (!process) { napi_throw_error(env, NULL, "Cannot open process"); return NULL; }
  DWORD exit_code;
  if (!GetExitCodeProcess(process, &exit_code) || exit_code != STILL_ACTIVE || !GetProcessTimes(process, &created, &exited, &kernel, &user) ||
      !QueryFullProcessImageNameW(process, 0, path, &length)) {
    CloseHandle(process); napi_throw_error(env, NULL, "Cannot query process identity"); return NULL;
  }
  CloseHandle(process);
  char stamp[32];
  snprintf(stamp, sizeof(stamp), "%08lx%08lx", (unsigned long)created.dwHighDateTime, (unsigned long)created.dwLowDateTime);
  napi_create_object(env, &value);
  napi_create_string_utf8(env, stamp, NAPI_AUTO_LENGTH, &start);
  napi_create_string_utf16(env, (const char16_t *)path, length, &executable);
  napi_set_named_property(env, value, "startTime", start);
  napi_set_named_property(env, value, "executable", executable);
  return value;
}
#endif

static napi_value initialize(napi_env env, napi_value exports) {
  napi_value lock_function;
  if (napi_create_function(env, "tryLock", NAPI_AUTO_LENGTH, try_lock, NULL, &lock_function) != napi_ok ||
      napi_set_named_property(env, exports, "tryLock", lock_function) != napi_ok) {
    napi_throw_error(env, NULL, "Could not export tryLock"); return NULL;
  }
#if defined(__APPLE__) || defined(_WIN32)
  napi_value function;
  if (napi_create_function(env, "getPathForFd", NAPI_AUTO_LENGTH, get_path_for_fd, NULL, &function) != napi_ok ||
      napi_set_named_property(env, exports, "getPathForFd", function) != napi_ok) {
    napi_throw_error(env, NULL, "Could not export getPathForFd");
    return NULL;
  }
#endif
#if defined(_WIN32)
  napi_value process_function;
  napi_create_function(env, "processInfo", NAPI_AUTO_LENGTH, process_info, NULL, &process_function);
  napi_set_named_property(env, exports, "processInfo", process_function);
#endif
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
