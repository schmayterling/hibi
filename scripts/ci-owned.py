import ctypes, ctypes.util, os, struct, sys

# For scripts/ci.mjs on macOS: prints "pid<TAB>name" for every process whose
# environment holds HIBI_CI_FILE with <tag> in its chain, or that is in <group>
tag, group = sys.argv[1], int(sys.argv[2])
libc = ctypes.CDLL(ctypes.util.find_library('c'), use_errno=True)
libproc = ctypes.CDLL('/usr/lib/libproc.dylib')
count = libproc.proc_listallpids(None, 0)
pids = (ctypes.c_int * (count * 2))()
count = libproc.proc_listallpids(pids, ctypes.sizeof(pids))
for pid in pids[:count]:
    if pid in (0, os.getpid()):
        continue
    # KERN_PROCARGS2: argc, exec path, padding, argv, then the environment.
    mib = (ctypes.c_int * 3)(1, 49, pid)
    size = ctypes.c_size_t(0)
    if libc.sysctl(mib, 3, None, ctypes.byref(size), None, 0) != 0:
        continue
    data = ctypes.create_string_buffer(size.value)
    if libc.sysctl(mib, 3, data, ctypes.byref(size), None, 0) != 0:
        continue
    raw = data.raw[: size.value]
    argc = struct.unpack('i', raw[:4])[0]
    end = raw.find(b'\0', 4)
    path = raw[4:end]
    # The strings start at the next 8-byte boundary after argc and the path,
    # so an empty argv[0] is read as one, not as padding.
    at = end + 1
    while (at - 4) % 8:
        at += 1
    strings = raw[at:].split(b'\0')
    # A layout this doesn't know isn't guessed at: ci.mjs names it.
    if end < 0 or raw[end:at].strip(b'\0') or len(strings) <= argc:
        print(f'unreadable\t{pid}')
        continue
    environment = []
    for entry in strings[argc:]:
        if not entry:
            break
        environment.append(entry)
    owned = any(
        entry.startswith(b'HIBI_CI_FILE=')
        and tag in entry[13:].decode('utf8', 'replace').split(':')
        for entry in environment
    )
    if not owned:
        try:
            owned = os.getpgid(pid) == group
        except OSError:
            pass
    if owned:
        name = os.path.basename(path.decode('utf8', 'replace'))
        print(f'{pid}\t{name}')
