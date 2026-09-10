#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif
#include <node_api.h>
#include <uv.h>
#include <windows.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <wchar.h>

static napi_value rename_error(napi_env env, DWORD code) {
  char message[96];
  snprintf(message, sizeof(message), "Windows atomic rename failed (error %lu)", (unsigned long)code);
  napi_throw_error(env, uv_err_name(uv_translate_sys_error(code)), message);
  return NULL;
}

napi_value replace_file(napi_env env, napi_callback_info info) {
  napi_value argv[2], result;
  size_t argc = 2, lengths[2];
  wchar_t paths[2][32768];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 2) {
    napi_throw_type_error(env, NULL, "replaceFile requires source and destination paths"); return NULL;
  }
  for (size_t i = 0; i < 2; i++) {
    if (napi_get_value_string_utf16(env, argv[i], NULL, 0, &lengths[i]) != napi_ok ||
        lengths[i] == 0 || lengths[i] >= 32768 ||
        napi_get_value_string_utf16(env, argv[i], (char16_t *)paths[i], 32768, &lengths[i]) != napi_ok ||
        wcslen(paths[i]) != lengths[i]) {
      napi_throw_type_error(env, NULL, "Invalid atomic rename path"); return NULL;
    }
  }
  HANDLE source = CreateFileW(paths[0], DELETE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                              NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
  if (source == INVALID_HANDLE_VALUE) return rename_error(env, GetLastError());
  DWORD bytes = (DWORD)(sizeof(FILE_RENAME_INFO) + lengths[1] * sizeof(wchar_t));
  FILE_RENAME_INFO *rename = (FILE_RENAME_INFO *)calloc(1, bytes);
  if (!rename) { CloseHandle(source); napi_throw_error(env, NULL, "Cannot allocate atomic rename"); return NULL; }
  // Preserve readers of the old file while atomically publishing the new name.
  rename->Flags = FILE_RENAME_FLAG_REPLACE_IF_EXISTS | FILE_RENAME_FLAG_POSIX_SEMANTICS;
  rename->FileNameLength = (DWORD)(lengths[1] * sizeof(wchar_t));
  memcpy(rename->FileName, paths[1], (lengths[1] + 1) * sizeof(wchar_t));
  BOOL success = SetFileInformationByHandle(source, FileRenameInfoEx, rename, bytes);
  DWORD error = success ? ERROR_SUCCESS : GetLastError();
  free(rename);
  CloseHandle(source);
  if (!success && (error == ERROR_INVALID_PARAMETER || error == ERROR_NOT_SUPPORTED)) {
    success = MoveFileExW(paths[0], paths[1], MOVEFILE_REPLACE_EXISTING);
    if (!success) error = GetLastError();
  }
  if (!success) return rename_error(env, error);
  napi_get_undefined(env, &result);
  return result;
}
