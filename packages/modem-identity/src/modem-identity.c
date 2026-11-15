// SPDX-License-Identifier: BSD-3-Clause
/* MSM8916 Qualcomm DIAG NV item 550. No arbitrary NV writes or unlock attempts. */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <glob.h>
#include <linux/rpmsg.h>
#include <poll.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

#define NV_SIZE 128
#define PACKET_SIZE 133
#ifndef NV_TIMEOUT_MS
#define NV_TIMEOUT_MS 8000
#endif
static int endpoint = -1, lock_fd = -1;
static bool test_transport;
static char error_text[256];
static char backup_path[512];
static const char *failure(const char *message)
{
    snprintf(error_text, sizeof(error_text), "%s", message);
    return NULL;
}

static int fail(const char *message)
{
    failure(message);
    return -1;
}

static long long milliseconds(void)
{
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return (long long)t.tv_sec * 1000 + t.tv_nsec / 1000000;
}

static uint16_t crc16(const uint8_t *p, size_t n)
{
    uint16_t c = 0xffff;
    for (size_t i = 0; i < n; i++) {
        c ^= p[i];
        for (int j = 0; j < 8; j++)
            c = (c >> 1) ^ ((c & 1) ? 0x8408 : 0);
    }
    return (uint16_t) ~c;
}

static bool valid_imei(const char *s)
{
    if (strlen(s) != 15)
        return false;
    int sum = 0;
    bool nonzero = false;
    for (int i = 0; i < 15; i++) {
        if (s[i] < '0' || s[i] > '9')
            return false;
        int d = s[i] - '0';
        nonzero |= d != 0;
        if (i % 2) {
            d *= 2;
            if (d > 9)
                d -= 9;
        }
        sum += d;
    }
    return nonzero && sum % 10 == 0;
}

static void encode_imei(const char *imei, uint8_t *nv)
{
    nv[0] = 8;
    nv[1] = (uint8_t) ((imei[0] - '0') << 4 | 0x0a);
    for (int i = 1; i < 15; i += 2)
        nv[2 + (i - 1) / 2] = (uint8_t) ((imei[i + 1] - '0') << 4 | (imei[i] - '0'));
}

static int decode_imei(const uint8_t *nv, char imei[16])
{
    if (nv[0] != 8 || (nv[1] & 15) != 10 || (nv[1] >> 4) > 9)
        return fail("Unsupported IMEI NV encoding");
    imei[0] = (char)('0' + (nv[1] >> 4));
    for (int i = 1; i < 15; i += 2) {
        uint8_t c = nv[2 + (i - 1) / 2];
        if ((c & 15) > 9 || (c >> 4) > 9)
            return fail("Invalid IMEI NV digits");
        imei[i] = (char)('0' + (c & 15));
        imei[i + 1] = (char)('0' + (c >> 4));
    }
    imei[15] = 0;
    return valid_imei(imei) ? 0 : fail("Modem IMEI fails the Luhn check");
}

static int number(const char *name)
{
    int n;
    char tail;
    return sscanf(name, "rpmsg%d%c", &n, &tail) == 1 && n >= 0 && n < 4096 ? n : -1;
}

static int controller(char *device, size_t length, char *parent, size_t plen)
{
    glob_t g;
    int found = 0;
    glob("/sys/class/rpmsg/rpmsg_ctrl*", 0, NULL, &g);
    for (size_t i = 0; i < g.gl_pathc; i++) {
        char resolved[4096], edge[4096], pattern[4200];
        if (!realpath(g.gl_pathv[i], resolved))
            continue;
        snprintf(edge, sizeof(edge), "%s", resolved);
        char *p = strstr(edge, "/rpmsg/rpmsg_ctrl");
        if (!p)
            continue;
        *p = 0;
        p = strrchr(edge, '/');
        if (!p)
            continue;
        *p = 0;
        snprintf(pattern, sizeof(pattern), "%s/*DIAG.-1.-1/name", edge);
        glob_t channels;
        glob(pattern, 0, NULL, &channels);
        if (channels.gl_pathc) {
            if (++found > 1) {
                globfree(&channels);
                globfree(&g);
                return fail("Multiple modem DIAG controllers; refusing ambiguous target");
            }
            snprintf(device, length, "/dev/%s", strrchr(g.gl_pathv[i], '/') + 1);
            snprintf(parent, plen, "%s", resolved);
        }
        globfree(&channels);
    }
    globfree(&g);
    return found ? 0 : fail("No modem RPMsg DIAG controller found");
}

static int open_transport(void)
{
#ifdef MODEM_IDENTITY_TEST
    const char *path = getenv("MODEM_IDENTITY_TEST_SOCKET");
    if (path) {
        struct sockaddr_un a = {.sun_family = AF_UNIX };
        if (strlen(path) >= sizeof(a.sun_path))
            return fail("Test socket path too long");
        strcpy(a.sun_path, path);
        endpoint = socket(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0);
        test_transport = true;
        return connect(endpoint, (struct sockaddr *)&a,
                       sizeof(a)) < 0 ? fail("Test socket unavailable") : 0;
    }
#endif
    char device[128], parent[4096];
    if (controller(device, sizeof(device), parent, sizeof(parent)) < 0)
        return -1;
    bool seen[4096] = { 0 };
    glob_t g;
    glob("/sys/class/rpmsg/rpmsg*", 0, NULL, &g);
    for (size_t i = 0; i < g.gl_pathc; i++) {
        int n = number(strrchr(g.gl_pathv[i], '/') + 1);
        if (n >= 0)
            seen[n] = true;
    }
    globfree(&g);
    int ctrl = open(device, O_RDWR | O_CLOEXEC | O_NOFOLLOW);
    if (ctrl < 0)
        return fail("Cannot open modem RPMsg controller");
    struct rpmsg_endpoint_info info = {.name = "DIAG",.src = RPMSG_ADDR_ANY,.dst = RPMSG_ADDR_ANY };
    int ret = ioctl(ctrl, RPMSG_CREATE_EPT_IOCTL, &info);
    close(ctrl);
    if (ret < 0)
        return fail("Cannot create DIAG endpoint");
    for (int attempt = 0; attempt < 20; attempt++) {
        glob("/sys/class/rpmsg/rpmsg*", 0, NULL, &g);
        for (size_t i = 0; i < g.gl_pathc; i++) {
            const char *base = strrchr(g.gl_pathv[i], '/') + 1;
            int n = number(base);
            char resolved[4096], node[128];
            if (n < 0 || seen[n] || !realpath(g.gl_pathv[i], resolved))
                continue;
            if (strncmp(resolved, parent, strlen(parent)) || resolved[strlen(parent)] != '/')
                continue;
            snprintf(node, sizeof(node), "/dev/%s", base);
            endpoint = open(node, O_RDWR | O_NONBLOCK | O_CLOEXEC | O_NOFOLLOW);
            if (endpoint >= 0) {
                globfree(&g);
                return 0;
            }
        }
        globfree(&g);
        usleep(50000);
    }
    return fail("Created DIAG endpoint could not be opened");
}

static void cleanup(void)
{
    if (endpoint >= 0) {
        if (!test_transport)
            ioctl(endpoint, RPMSG_DESTROY_EPT_IOCTL);
        close(endpoint);
    }
    if (lock_fd >= 0)
        close(lock_fd);
}

static int exchange(uint8_t command, const uint8_t input[NV_SIZE], uint8_t output[NV_SIZE])
{
    uint8_t packet[PACKET_SIZE] = { 0 }, frame[272], buffer[8192], decoded[8192];
    size_t n = 0, used = 0;
    bool escaped = false;
    packet[0] = command;
    packet[1] = 0x26;
    packet[2] = 2;
    if (input)
        memcpy(packet + 3, input, NV_SIZE);
    uint16_t crc = crc16(packet, sizeof(packet));
    for (size_t i = 0; i < sizeof(packet) + 2; i++) {
        uint8_t c = i < sizeof(packet) ? packet[i] : i == sizeof(packet) ? crc & 255 : crc >> 8;
        if (c == 0x7e || c == 0x7d) {
            frame[n++] = 0x7d;
            frame[n++] = c ^ 0x20;
        } else
            frame[n++] = c;
    }
    frame[n++] = 0x7e;
    long long deadline = milliseconds() + NV_TIMEOUT_MS;
    for (;;) {
        ssize_t written = write(endpoint, frame, n);
        if (written == (ssize_t) n)
            break;
        if (written < 0 && (errno == EINTR || errno == EAGAIN)) {
            if (milliseconds() >= deadline)
                return fail("DIAG request send timed out");
            struct pollfd p = {.fd = endpoint,.events = POLLOUT };
            poll(&p, 1, 100);
            continue;
        }
        return fail("DIAG request send failed; write outcome may be unknown");
    }
    while (milliseconds() < deadline) {
        struct pollfd p = {.fd = endpoint,.events = POLLIN };
        int r = poll(&p, 1, (int)(deadline - milliseconds()));
        if (r < 0 && errno == EINTR)
            continue;
        if (r <= 0)
            break;
        if (p.revents & (POLLERR | POLLHUP | POLLNVAL))
            return fail("DIAG channel disconnected; write outcome may be unknown");
        ssize_t got = read(endpoint, buffer, sizeof(buffer));
        if (got < 0 && (errno == EAGAIN || errno == EINTR))
            continue;
        if (got <= 0)
            return fail("DIAG response read failed");
        for (ssize_t j = 0; j < got; j++) {
            uint8_t c = buffer[j];
            if (c == 0x7e) {
                if (used >= 3 && !escaped) {
                    uint16_t expected = decoded[used - 2] | decoded[used - 1] << 8;
                    if (crc16(decoded, used - 2) != expected) {
                        used = 0;
                        escaped = false;
                        continue;
                    }
                    if (decoded[0] == 0x13 || decoded[0] == 0x14 || decoded[0] == 0x15 ||
                        decoded[0] == 0x18) {
                        return fail("Modem rejected DIAG request; no unlock bypass attempted");
                    }
                    if (decoded[0] == command) {
                        if (used != PACKET_SIZE + 2)
                            return fail("Unexpected NV response size");
                        if (decoded[1] != 0x26 || decoded[2] != 2)
                            return fail("NV response is for another item");
                        unsigned status = decoded[131] | decoded[132] << 8;
                        if (status) {
                            snprintf(error_text, sizeof(error_text),
                                     "Modem rejected NV item 550: status %u", status);
                            return -1;
                        }
                        memcpy(output, decoded + 3, NV_SIZE);
                        return 0;
                    }
                }
                used = 0;
                escaped = false;
                continue;
            }
            if (escaped) {
                c ^= 0x20;
                escaped = false;
            } else if (c == 0x7d) {
                escaped = true;
                continue;
            }
            if (used >= sizeof(decoded))
                return fail("Oversized DIAG response");
            decoded[used++] = c;
        }
    }
    return fail(command ==
                0x27 ? "NV write timed out; outcome unknown. Read current IMEI before retrying" :
                "IMEI NV read timed out");
}

/* -r in rmtfs keeps NV changes in RAM. Refuse to call that a persistent change. */
static int persistent_mode(void)
{
#ifdef MODEM_IDENTITY_TEST
    if (test_transport)
        return getenv("MODEM_IDENTITY_TEST_READONLY") ? 0 : 1;
#endif
    glob_t g;
    int found = 0, writable = 0;
    glob("/proc/[0-9]*/cmdline", 0, NULL, &g);
    for (size_t i = 0; i < g.gl_pathc; i++) {
        char b[4096];
        int fd = open(g.gl_pathv[i], O_RDONLY | O_CLOEXEC);
        if (fd < 0)
            continue;
        ssize_t n = read(fd, b, sizeof(b) - 1);
        close(fd);
        if (n <= 0)
            continue;
        b[n] = 0;
        const char *base = strrchr(b, '/');
        base = base ? base + 1 : b;
        if (strcmp(base, "rmtfs"))
            continue;
        found++;
        bool ro = false;
        size_t offset = strlen(b) + 1;
        while (offset < (size_t)n) {
            size_t size = strnlen(b + offset, (size_t)n - offset);
            if (size > 1 && b[offset] == '-' && b[offset + 1] != '-' && strchr(b + offset + 1, 'r'))
                ro = true;
            offset += size + 1;
        }
        if (!ro)
            writable++;
    }
    globfree(&g);
    return found == 1 && writable == 1 ? 1 : 0;
}

static int save_backup(const uint8_t nv[NV_SIZE], const char *directory)
{
    struct stat st;
    if (lstat(directory, &st) < 0) {
        if (errno != ENOENT || mkdir(directory, 0700) < 0)
            return fail("Cannot create NV backup directory");
        if (lstat(directory, &st) < 0)
            return fail("Cannot inspect NV backup directory");
    }
    if (!S_ISDIR(st.st_mode) || st.st_uid != geteuid() || (st.st_mode & 077) != 0)
        return fail("Backup directory must be owned by root with mode 0700");
    int d = open(directory, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (d < 0)
        return fail("Cannot open NV backup directory");
    char name[96];
    snprintf(name, sizeof(name), "item550-%lld-%ld.nv", (long long)time(NULL), (long)getpid());
    int fd = openat(d, name, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600);
    if (fd < 0) {
        close(d);
        return fail("Cannot create unique NV backup");
    }
    uint8_t file[144] = { 0 };
    memcpy(file, "MIFIIMEI1", 9);
    file[10] = 0x26;
    file[11] = 2;
    file[12] = NV_SIZE;
    memcpy(file + 16, nv, NV_SIZE);
    uint16_t checksum = crc16(nv, NV_SIZE);
    file[14] = checksum & 255;
    file[15] = checksum >> 8;
    bool ok = write(fd, file, sizeof(file)) == (ssize_t) sizeof(file) && fsync(fd) == 0;
    close(fd);
    ok = fsync(d) == 0 && ok;
    close(d);
    if (!ok)
        return fail("NV backup could not be persisted; no write attempted");
    if (snprintf(backup_path, sizeof(backup_path), "%s/%s", directory, name) >=
        (int)sizeof(backup_path))
        return fail("Backup path too long");
    return 0;
}

static int restore_data(const char *path, uint8_t nv[NV_SIZE])
{
    int fd = open(path, O_RDONLY | O_NONBLOCK | O_CLOEXEC | O_NOFOLLOW);
    if (fd < 0)
        return fail("Cannot open NV backup");
    struct stat st;
    if (fstat(fd, &st) < 0 || !S_ISREG(st.st_mode) || st.st_size != 144) {
        close(fd);
        return fail("NV backup must be a regular 144-byte file");
    }
    uint8_t b[145];
    ssize_t n = read(fd, b, sizeof(b));
    close(fd);
    if (n != 144 || memcmp(b, "MIFIIMEI1", 9) || b[10] != 0x26 || b[11] != 2 ||
        b[12] != NV_SIZE || b[13] != 0 || crc16(b + 16, NV_SIZE) != (b[14] | b[15] << 8))
        return fail("Invalid IMEI NV backup");
    memcpy(nv, b + 16, NV_SIZE);
    char imei[16];
    return decode_imei(nv, imei);
}

static void json_string(const char *s)
{
    putchar('"');
    for (; *s; s++) {
        unsigned char c = (unsigned char)*s;
        if (c == '"' || c == '\\') {
            putchar('\\');
            putchar(c);
        } else if (c < 32)
            printf("\\u%04x", c);
        else
            putchar(c);
    }
    putchar('"');
}

static void usage(void)
{
    puts("modem-identity read\nmodem-identity validate IMEI\nmodem-identity set IMEI --expect CURRENT [--backup-dir DIRECTORY]\nmodem-identity restore BACKUP --expect CURRENT [--backup-dir DIRECTORY]\nOutput is JSON. Changing IMEI requires writable rmtfs; no automatic reboot or unlock.");
}

int main(int argc, char **argv)
{
    atexit(cleanup);
    if (argc < 2) {
        usage();
        return 2;
    }
    if (!strcmp(argv[1], "--help")) {
        usage();
        return 0;
    }
    if (!strcmp(argv[1], "validate")) {
        bool valid = argc == 3 && valid_imei(argv[2]);
        printf("{\"valid\":%s}\n", valid ? "true" : "false");
        return valid ? 0 : 2;
    }
    bool change = !strcmp(argv[1], "set"), restore = !strcmp(argv[1], "restore"), read_only =
        !strcmp(argv[1], "read");
    if (!change && !restore && !read_only) {
        usage();
        return 2;
    }
    const char *expected = NULL, *directory = "/etc/modem-identity-backups";
    if (read_only && argc != 2) {
        usage();
        return 2;
    }
    if (!read_only) {
        if (argc < 5) {
            usage();
            return 2;
        }
        if (change && !valid_imei(argv[2])) {
            failure("IMEI must be 15 decimal digits with a valid Luhn check digit");
            goto error;
        }
        for (int i = 3; i < argc; i += 2) {
            if (i + 1 >= argc) {
                failure("Missing option value");
                goto error;
            }
            if (!strcmp(argv[i], "--expect"))
                expected = argv[i + 1];
            else if (!strcmp(argv[i], "--backup-dir"))
                directory = argv[i + 1];
            else {
                failure("Unknown option");
                goto error;
            }
        }
        if (!expected || !valid_imei(expected)) {
            failure("--expect must match the current modem IMEI");
            goto error;
        }
    }
#ifndef MODEM_IDENTITY_TEST
    if (geteuid() != 0) {
        failure("Root privileges are required");
        goto error;
    }
    const char *lock = "/var/lock/modem-identity.lock";
#else
    const char *lock = getenv("MODEM_IDENTITY_TEST_LOCK");
    if (!lock)
        lock = "/tmp/modem-identity-test.lock";
#endif
    lock_fd = open(lock, O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW, 0600);
    if (lock_fd < 0 || flock(lock_fd, LOCK_EX | LOCK_NB) < 0) {
        failure("Another modem identity operation is running, or lock is unavailable");
        goto error;
    }
    if (open_transport() < 0)
        goto error;
    uint8_t current[NV_SIZE], desired[NV_SIZE], verified[NV_SIZE];
    char imei[16], target[16];
    if (exchange(0x26, NULL, current) < 0 || decode_imei(current, imei) < 0)
        goto error;
    if (read_only) {
        printf("{\"imei\":\"%s\",\"nv_item\":550,\"persistent_writes\":%s}\n", imei,
               persistent_mode()? "true" : "false");
        return 0;
    }
    if (strcmp(expected, imei)) {
        failure("Current IMEI differs from --expect; no write attempted");
        goto error;
    }
    memcpy(desired, current, NV_SIZE);
    if (change) {
        encode_imei(argv[2], desired);
        strcpy(target, argv[2]);
    } else {
        if (restore_data(argv[2], desired) < 0 || decode_imei(desired, target) < 0)
            goto error;
    }
    if (!memcmp(current, desired, NV_SIZE)) {
        printf("{\"changed\":false,\"imei\":\"%s\"}\n", imei);
        return 0;
    }
    if (!persistent_mode()) {
        failure
            ("rmtfs is read-only or unavailable. Enable writable mode and restart it before changing IMEI");
        goto error;
    }
    if (save_backup(current, directory) < 0)
        goto error;
    if (exchange(0x27, desired, verified) < 0)
        goto error;
    if (exchange(0x26, NULL, verified) < 0)
        goto error;
    if (memcmp(desired, verified, NV_SIZE)) {
        failure
            ("NV write readback mismatch; original backup retained. Read current IMEI before recovery");
        goto error;
    }
    printf("{\"changed\":true,\"imei\":\"%s\",\"backup\":", target);
    json_string(backup_path);
    puts(",\"readback_verified\":true,\"persistence_verified\":false,\"modem_restart_required\":true}");
    return 0;
  error:
    printf("{\"error\":");
    json_string(error_text);
    if (backup_path[0]) {
        printf(",\"backup\":");
        json_string(backup_path);
    }
    puts("}");
    return 1;
}
