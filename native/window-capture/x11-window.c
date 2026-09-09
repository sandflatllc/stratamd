/* Read identity and geometry for one explicitly selected X11 window.
 * Resolve Xlib at runtime so the build needs only the C toolchain, and a missing
 * X11 library produces screenshot-only capture on the user's computer. */
#include <dlfcn.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
typedef void Display;
typedef unsigned long Window;
typedef unsigned long Atom;
static int ignore_error(Display *display, void *event) { (void)display; (void)event; return 0; }
static void json_string(const char *value) {
  putchar('"');
  for (const unsigned char *p = (const unsigned char *)value; *p; p++) {
    if (*p == '"' || *p == '\\') { putchar('\\'); putchar(*p); }
    else if (*p < 32) printf("\\u%04x", *p);
    else putchar(*p);
  }
  putchar('"');
}
#define LOAD(name) do { *(void **)(&name) = dlsym(library, #name); if (!name) return 3; } while (0)
int main(int argc, char **argv) {
  if (argc != 2) return 1;
  char *end = NULL; errno = 0;
  Window selected = strtoul(argv[1], &end, 10);
  if (errno || !selected || !end || *end) return 1;
  void *library = dlopen("libX11.so.6", RTLD_NOW | RTLD_LOCAL);
  if (!library) return 2;
  Display *(*XOpenDisplay)(const char *);
  int (*XCloseDisplay)(Display *);
  int (*XGetGeometry)(Display *, Window, Window *, int *, int *, unsigned int *, unsigned int *, unsigned int *, unsigned int *);
  int (*XTranslateCoordinates)(Display *, Window, Window, int, int, int *, int *, Window *);
  Atom (*XInternAtom)(Display *, const char *, int);
  int (*XGetWindowProperty)(Display *, Window, Atom, long, long, int, Atom, Atom *, int *, unsigned long *, unsigned long *, unsigned char **);
  int (*XFree)(void *);
  void *(*XSetErrorHandler)(int (*)(Display *, void *));
  LOAD(XOpenDisplay); LOAD(XCloseDisplay); LOAD(XGetGeometry); LOAD(XTranslateCoordinates);
  LOAD(XInternAtom); LOAD(XGetWindowProperty); LOAD(XFree); LOAD(XSetErrorHandler);
  Display *display = XOpenDisplay(NULL);
  if (!display) return 4;
  XSetErrorHandler(ignore_error);
  Window root, child; int x, y; unsigned int width, height, border, depth;
  if (!XGetGeometry(display, selected, &root, &x, &y, &width, &height, &border, &depth) ||
      !XTranslateCoordinates(display, selected, root, 0, 0, &x, &y, &child)) { XCloseDisplay(display); return 5; }
  Atom actual; int format; unsigned long count, remaining; unsigned char *data = NULL;
  unsigned long pid = 0;
  if (!XGetWindowProperty(display, selected, XInternAtom(display, "_NET_WM_PID", 1), 0, 1, 0, 0, &actual, &format, &count, &remaining, &data) && format == 32 && count == 1 && data) pid = *(unsigned long *)data;
  if (data) XFree(data);
  data = NULL;
  char name[1025] = {0};
  if (!XGetWindowProperty(display, selected, XInternAtom(display, "WM_CLASS", 1), 0, 256, 0, 0, &actual, &format, &count, &remaining, &data) && format == 8 && data && count) {
    size_t offset = strnlen((char *)data, count) + 1;
    if (offset >= count) offset = 0;
    size_t length = strnlen((char *)data + offset, count - offset);
    if (length > 1024) length = 1024;
    memcpy(name, data + offset, length);
  }
  if (data) XFree(data);
  printf("{\"pid\":%lu,\"app\":", pid); json_string(name);
  printf(",\"bounds\":{\"x\":%d,\"y\":%d,\"width\":%u,\"height\":%u}}\n", x, y, width, height);
  XCloseDisplay(display); dlclose(library); return 0;
}
