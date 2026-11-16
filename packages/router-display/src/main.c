#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <getopt.h>
#include <unistd.h>
#include <ctype.h>
#include <time.h>
#include <math.h>
#include <ft2build.h>
#include FT_FREETYPE_H
#include "qrcodegen.h"

#define WIDTH 128
#define HEIGHT 128
#define RGB565(r,g,b) (((r & 0xF8) << 8) | ((g & 0xFC) << 3) | ((b & 0xF8) >> 3))

#define COLOR_WHITE RGB565(255, 255, 255)
#define COLOR_BLACK RGB565(0, 0, 0)

#define QR_SIZE 108
#define QR_TOP_MARGIN 6
#define TEXT_HEIGHT 13
#define MIN_MODULE_SIZE 2  // Include the required four-module quiet zone.

typedef struct {
    uint16_t data[WIDTH * HEIGHT];
} Framebuffer;

typedef struct {
    int battery;
    int charging;        // NEW: charging flag
    char operator[32];
    char network_type[8];
    char ssid[64];
    char password[64];
    char hostname[32];
    int show_qr;
    int uppercase;
    int dashboard;
    int analog_clock;
    int ping_history;
    time_t ping_now;
    int sms;
    unsigned sms_page;
    int clock_hour, clock_minute, clock_second;
    int battery_estimated;
    int signal;
    int flow;
    char imei[16];
    char phone[32];
    char download[24];
    char upload[24];
    char interface[24];
} DisplayConfig;

void fb_init(Framebuffer *fb) {
    memset(fb->data, 0, sizeof(fb->data));
}

void fb_put_pixel(Framebuffer *fb, int x, int y, uint16_t color) {
    if (x >= 0 && x < WIDTH && y >= 0 && y < HEIGHT) {
        fb->data[y * WIDTH + x] = color;
    }
}

void fb_blend_pixel(Framebuffer *fb, int x, int y, unsigned char gray) {
    if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) return;
    if (gray == 0) return;
    
    uint16_t bg_color = fb->data[y * WIDTH + x];
    
    uint8_t bg_r = (bg_color >> 11) << 3;
    uint8_t bg_g = ((bg_color >> 5) & 0x3F) << 2;
    uint8_t bg_b = (bg_color & 0x1F) << 3;
    
    float alpha = gray / 255.0f;
    uint8_t r = (uint8_t)(255 * alpha + bg_r * (1.0f - alpha));
    uint8_t g = (uint8_t)(255 * alpha + bg_g * (1.0f - alpha));
    uint8_t b = (uint8_t)(255 * alpha + bg_b * (1.0f - alpha));
    
    fb->data[y * WIDTH + x] = RGB565(r, g, b);
}

void fb_draw_rect(Framebuffer *fb, int x, int y, int w, int h, uint16_t color) {
    for (int j = 0; j < h; j++) {
        for (int i = 0; i < w; i++) {
            fb_put_pixel(fb, x + i, y + j, color);
        }
    }
}

/* Decode complete UTF-8 code points for FreeType and SMS line wrapping. */
static unsigned long utf8_next(const char **cursor) {
    const unsigned char *p = (const unsigned char *)*cursor;
    unsigned long cp = *p++;
    if (cp >= 0x80) {
        int count = cp >= 0xf0 && cp <= 0xf4 ? 3 : cp >= 0xe0 && cp <= 0xef ? 2 : cp >= 0xc2 && cp <= 0xdf ? 1 : 0;
        unsigned long minimum = count == 3 ? 0x10000 : count == 2 ? 0x800 : 0x80;
        if (!count) cp = 0xfffd;
        else {
            cp &= (1u << (6 - count)) - 1;
            for (int i = 0; i < count; i++) {
                if ((*p & 0xc0) != 0x80) { cp = 0xfffd; break; }
                cp = (cp << 6) | (*p++ & 0x3f);
            }
            if (cp < minimum || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) cp = 0xfffd;
        }
    }
    *cursor = (const char *)p;
    return cp;
}

void fb_draw_text(Framebuffer *fb, FT_Face face, const char *text, int x, int y, int size) {
    int pen_x = x;
    
    for (const char *p = text; *p;) {
        unsigned long cp = utf8_next(&p);
        FT_Set_Pixel_Sizes(face, 0, size);
        
        if (FT_Load_Char(face, cp, FT_LOAD_RENDER | FT_LOAD_TARGET_NORMAL)) {
            continue;
        }
        
        FT_GlyphSlot slot = face->glyph;
        FT_Bitmap bitmap = slot->bitmap;
        
        for (unsigned int row = 0; row < bitmap.rows; row++) {
            for (unsigned int col = 0; col < bitmap.width; col++) {
                int px = pen_x + slot->bitmap_left + col;
                int py = y - slot->bitmap_top + row;
                
                unsigned char gray = bitmap.buffer[row * bitmap.pitch + col];
                
                if (gray > 0) {
                    fb_blend_pixel(fb, px, py, gray);
                }
            }
        }
        
        pen_x += slot->advance.x >> 6;
    }
}

int fb_get_text_width(FT_Face face, const char *text, int size) {
    int width = 0;
    FT_Set_Pixel_Sizes(face, 0, size);
    
    for (const char *p = text; *p;) {
        unsigned long cp = utf8_next(&p);
        if (FT_Load_Char(face, cp, FT_LOAD_RENDER)) {
            continue;
        }
        width += face->glyph->advance.x >> 6;
    }
    
    return width;
}

int fb_draw_qr(Framebuffer *fb, const char *text, int x, int y, int size) {
    uint8_t qr_data[qrcodegen_BUFFER_LEN_MAX];
    uint8_t temp_buffer[qrcodegen_BUFFER_LEN_MAX];
    
    bool ok = qrcodegen_encodeText(text, temp_buffer, qr_data,
                                   qrcodegen_Ecc_LOW, 
                                   qrcodegen_VERSION_MIN,
                                   qrcodegen_VERSION_MAX,
                                   qrcodegen_Mask_AUTO, true);
    
    if (!ok) {
        fprintf(stderr, "QR generation failed\n");
        return 0;
    }
    
    int qr_modules = qrcodegen_getSize(qr_data);
    int module_size = size / (qr_modules + 8);
    
    // Check if QR modules are too small (minimum pixels per module)
    if (module_size < MIN_MODULE_SIZE) {
        fprintf(stderr, "QR too large for display area (needs %d modules, only fits %dpx modules)\n", 
                qr_modules, module_size);
        return 0;  // Don't draw, QR would be unreadable
    }
    
    // Center the complete QR code, including its quiet zone.
    int actual_qr_size = (qr_modules + 8) * module_size;
    int offset_x = (size - actual_qr_size) / 2;  // Center horizontally
    int offset_y = (size - actual_qr_size) / 2;
    fb_draw_rect(fb, x, y, size, size, COLOR_WHITE);
    
    for (int row = 0; row < qr_modules; row++) {
        for (int col = 0; col < qr_modules; col++) {
            if (qrcodegen_getModule(qr_data, col, row)) {
                fb_draw_rect(fb, 
                           x + offset_x + (col + 4) * module_size,
                           y + offset_y + (row + 4) * module_size,
                           module_size, module_size, 
                           COLOR_BLACK);
            }
        }
    }
    
    return 1;  // QR drawn successfully
}

void str_to_upper(char *str) {
    for (char *p = str; *p; p++) {
        *p = toupper((unsigned char)*p);
    }
}

/* Wi-Fi QR syntax requires escaping reserved characters in credentials. */
static void wifi_escape(char *out, const char *value) {
    while (*value) {
        if (strchr("\\;,:\"", *value)) *out++ = '\\';
        *out++ = *value++;
    }
    *out = '\0';
}

/* Dashboard coordinates are fitted to the physical 128 x 128 panel. */
static void draw_fitted(Framebuffer *fb, FT_Face face, const char *value,
                        int x, int baseline, int size, int width, int right) {
    char text[64];
    snprintf(text, sizeof(text), "%s", value);
    while (*text && fb_get_text_width(face, text, size) > width)
        text[strlen(text) - 1] = 0;
    int measured = fb_get_text_width(face, text, size);
    fb_draw_text(fb, face, text, right ? x + width - measured : x, baseline, size);
}

/* Shared dashboard grid: six-pixel margins, 9px headings and 11px values. */
static void dashboard_bar(Framebuffer *fb, int y, int value, int battery) {
    const int margin = 6, width = WIDTH - 12;
    fb_draw_rect(fb, margin, y, width, 4, RGB565(54, 65, 80));
    if (value >= 0) {
        uint16_t color = battery && value <= 15 ? RGB565(255, 120, 105) : RGB565(99, 222, 176);
        fb_draw_rect(fb, margin, y, width * value / 100, 4, color);
    }
}

static void dashboard_value(Framebuffer *fb, FT_Face face, const char *value, int baseline) {
    int size = 11;
    while (size > 1 && fb_get_text_width(face, value, size) > WIDTH - 12) size--;
    fb_draw_text(fb, face, value, 6, baseline, size);
}

static void generate_dashboard(Framebuffer *fb, DisplayConfig *cfg, FT_Face face) {
    fb_init(fb);
    fb_draw_text(fb, face, "Battery", 6, 13, 9);
    if (cfg->charging) draw_fitted(fb, face, "Charging", 69, 13, 9, 53, 1);
    dashboard_bar(fb, 18, cfg->battery, 1);

    const char *network = cfg->operator;
    if (!*network || !strcmp(network, "--") || !strcmp(network, "Unknown") ||
        !strcmp(network, "Not registered") || !strcmp(network, "No modem")) network = "Signal";
    draw_fitted(fb, face, network, 6, 33, 9, 85, 0);
    if (*cfg->network_type && strcmp(cfg->network_type, "--"))
        draw_fitted(fb, face, cfg->network_type, 94, 33, 9, 28, 1);
    dashboard_bar(fb, 38, cfg->signal, 0);

    fb_draw_text(fb, face, "Data", 6, 53, 9);
    dashboard_bar(fb, 58, cfg->flow, 0);

    /* No placeholder row below signal; the identity fields share one rhythm. */
    fb_draw_text(fb, face, "IMEI", 6, 77, 9);
    dashboard_value(fb, face, cfg->imei[0] ? cfg->imei : "Unavailable", 91);
    fb_draw_text(fb, face, "Phone", 6, 107, 9);
    dashboard_value(fb, face, cfg->phone[0] ? cfg->phone : "Unavailable", 121);
}

void generate_display(Framebuffer *fb, DisplayConfig *cfg, FT_Face face) {
    if (cfg->dashboard) { generate_dashboard(fb, cfg, face); return; }
    fb_init(fb);
    
    char operator_text[32], network_text[8], hostname_text[32];
    snprintf(operator_text, sizeof(operator_text), "%s", cfg->operator);
    snprintf(network_text, sizeof(network_text), "%s", cfg->network_type);
    snprintf(hostname_text, sizeof(hostname_text), "%s", cfg->hostname);
    
    if (cfg->uppercase) {
        str_to_upper(operator_text);
        str_to_upper(network_text);
        str_to_upper(hostname_text);
    }
    
    if (cfg->show_qr) {
        char ssid[sizeof(cfg->ssid) * 2], password[sizeof(cfg->password) * 2];
        char wifi_qr[512];
        wifi_escape(ssid, cfg->ssid);
        wifi_escape(password, cfg->password);
        snprintf(wifi_qr, sizeof(wifi_qr), "WIFI:T:%s;S:%s;P:%s;;",
                 cfg->password[0] ? "WPA" : "nopass", ssid, password);
        if (!fb_draw_qr(fb, wifi_qr, 0, 0, WIDTH))
            fb_draw_text(fb, face, "Wi-Fi QR too large", 5, 64, 12);
        return;
    }
    // The legacy non-QR page keeps its status labels on a black background.
    
    int fontsz = 12;
    int line1_y = HEIGHT - fontsz - 3;
    int line2_y = HEIGHT - 3;
    
    fb_draw_text(fb, face, operator_text, 2, line1_y, fontsz);
    
    int net_width = fb_get_text_width(face, network_text, fontsz);
    fb_draw_text(fb, face, network_text, WIDTH - net_width - 2, line1_y, fontsz);
    
    fb_draw_text(fb, face, hostname_text, 2, line2_y, fontsz);
    
    // NEW: Format battery with charging indicator
    char battery_text[16];
    if (cfg->charging) {
        snprintf(battery_text, sizeof(battery_text), "+%d%%", cfg->battery);
    } else {
        snprintf(battery_text, sizeof(battery_text), "%d%%", cfg->battery);
    }
    
    int battery_width = fb_get_text_width(face, battery_text, fontsz);
    fb_draw_text(fb, face, battery_text, WIDTH - battery_width - 2, line2_y, fontsz);
}

/* Integer raster lines keep the clock crisp on the 128 x 128 panel. */
static void clock_line(Framebuffer *fb, int x0, int y0, int x1, int y1, uint16_t color) {
    int dx = abs(x1-x0), sx = x0<x1 ? 1 : -1;
    int dy = -abs(y1-y0), sy = y0<y1 ? 1 : -1, error = dx+dy;
    for (;;) {
        fb_put_pixel(fb, x0, y0, color);
        if (x0==x1 && y0==y1) break;
        int twice = 2*error;
        if (twice>=dy) { error+=dy; x0+=sx; }
        if (twice<=dx) { error+=dx; y0+=sy; }
    }
}

static void clock_hand(Framebuffer *fb, double angle, int length, int tail, int width, uint16_t color) {
    double x=sin(angle), y=-cos(angle);
    for (int ox=-(width/2); ox<=width/2; ox++) {
        for (int oy=-(width/2); oy<=width/2; oy++) {
            clock_line(fb,64-(int)lround(x*tail)+ox,64-(int)lround(y*tail)+oy,
                       64+(int)lround(x*length)+ox,64+(int)lround(y*length)+oy,color);
        }
    }
}

static void generate_clock(Framebuffer *fb, DisplayConfig *cfg, FT_Face face) {
    time_t now=time(NULL);
    struct tm local;
    localtime_r(&now,&local);
    int hour=cfg->clock_hour>=0 ? cfg->clock_hour : local.tm_hour;
    int minute=cfg->clock_hour>=0 ? cfg->clock_minute : local.tm_min;
    int second=cfg->clock_hour>=0 ? cfg->clock_second : local.tm_sec;
    const double turn=6.283185307179586;
    const uint16_t face_color=RGB565(125,145,162), accent=RGB565(99,222,176);
    fb_init(fb);
    for (int degree=0;degree<360;degree++) {
        double a=degree*turn/360;
        fb_put_pixel(fb,64+(int)lround(sin(a)*50),64-(int)lround(cos(a)*50),RGB565(38,53,66));
    }
    for (int tick=0;tick<60;tick++) {
        double a=tick*turn/60;
        int inner=tick%5==0?43:47;
        clock_line(fb,64+(int)lround(sin(a)*inner),64-(int)lround(cos(a)*inner),
                   64+(int)lround(sin(a)*49),64-(int)lround(cos(a)*49),face_color);
    }
    fb_draw_text(fb,face,"12",56,35,11);
    fb_draw_text(fb,face,"3",97,68,11);
    fb_draw_text(fb,face,"6",60,103,11);
    fb_draw_text(fb,face,"9",24,68,11);
    clock_hand(fb,((hour%12)+minute/60.0)*turn/12,24,3,3,COLOR_WHITE);
    clock_hand(fb,(minute+second/60.0)*turn/60,35,4,1,COLOR_WHITE);
    clock_hand(fb,second*turn/60,41,8,1,accent);
    fb_draw_rect(fb,62,62,5,5,accent);
}

/* One-hour probe availability above a 58-bar, half-screen history plot. */
static void ping_duration(char *out, size_t size, double ms) {
    if (ms < 0) snprintf(out, size, "--");
    else if (ms >= 1000) snprintf(out, size, "%.1fs", ms / 1000);
    else snprintf(out, size, "%.0fms", ms);
}

static void generate_ping(Framebuffer *fb, FT_Face face, time_t now) {
    enum { MARGIN = 6, PLOT_WIDTH = 116, COLUMNS = 58, PLOT_TOP = 68, PLOT_HEIGHT = 54 };
    double samples[360], peaks[COLUMNS] = {0};
    long long times[360] = {0};
    int present[COLUMNS] = {0}, lost[COLUMNS] = {0};
    char line[128], extra, text[40], duration[16];
    long long timestamp, start = (long long)now / 10 - 359;
    double ms, maximum = 0, minimum = -1, sum = 0, last_success = -1;
    int count = 0, successes = 0, latest = -1;
    while (fgets(line, sizeof(line), stdin)) {
        if (sscanf(line, "%lld %lf %c", &timestamp, &ms, &extra) != 2 || !isfinite(ms)) continue;
        if (timestamp <= (long long)now - 3600 || timestamp > (long long)now || ms < -1) continue;
        long long slot = timestamp / 10 - start;
        if (slot < 0 || slot >= 360 || timestamp < times[slot]) continue;
        times[slot] = timestamp; samples[slot] = ms;
    }
    for (int slot = 0; slot < 360; slot++) {
        if (!times[slot]) continue;
        ms = samples[slot]; count++; latest = slot;
        int column = slot * COLUMNS / 360;
        present[column] = 1;
        if (ms < 0) lost[column] = 1;
        else {
            successes++; sum += ms; last_success = ms;
            if (minimum < 0 || ms < minimum) minimum = ms;
            if (ms > maximum) maximum = ms;
            if (ms > peaks[column]) peaks[column] = ms;
        }
    }
    fb_init(fb);
    fb_draw_text(fb, face, "PING / 1H", 6, 13, 9);
    const char *status = latest < 0 ? "WAIT" : now - times[latest] > 30 ? "STALE" : samples[latest] < 0 ? "DOWN" : "LIVE";
    uint16_t accent = latest < 0 || now - times[latest] > 30 ? RGB565(117,136,156) : samples[latest] < 0 ? RGB565(196,88,97) : RGB565(99,222,176);
    fb_draw_rect(fb, 86, 8, 3, 3, accent);
    draw_fitted(fb, face, status, 91, 13, 8, 31, 1);
    fb_draw_text(fb, face, "UPTIME", 6, 25, 8);
    fb_draw_text(fb, face, "DOWNTIME", 69, 25, 8);
    if (count) snprintf(text, sizeof(text), "%.1f%%", 100.0 * successes / count);
    else snprintf(text, sizeof(text), "--");
    fb_draw_text(fb, face, text, 6, 38, 12);
    if (count) snprintf(text, sizeof(text), "%.1f%%", 100.0 * (count - successes) / count);
    else snprintf(text, sizeof(text), "--");
    fb_draw_text(fb, face, text, 69, 38, 12);
    fb_draw_rect(fb, 63, 20, 1, 19, RGB565(35,46,60));
    ping_duration(duration, sizeof(duration), last_success);
    snprintf(text, sizeof(text), "LAST %s", duration);
    draw_fitted(fb, face, text, 6, 51, 8, 56, 0);
    ping_duration(duration, sizeof(duration), successes ? sum / successes : -1);
    snprintf(text, sizeof(text), "AVG %s", duration);
    draw_fitted(fb, face, text, 69, 51, 8, 53, 0);
    ping_duration(duration, sizeof(duration), minimum);
    snprintf(text, sizeof(text), "MIN %s", duration);
    draw_fitted(fb, face, text, 6, 61, 8, 56, 0);
    ping_duration(duration, sizeof(duration), successes ? maximum : -1);
    snprintf(text, sizeof(text), "MAX %s", duration);
    draw_fitted(fb, face, text, 69, 61, 8, 53, 0);

    double ceiling = fmax(50, ceil(maximum / 50) * 50);
    for (int grid = 0; grid < 3; grid++)
        fb_draw_rect(fb, MARGIN, PLOT_TOP + grid * (PLOT_HEIGHT - 1) / 2, PLOT_WIDTH, 1, RGB565(25,34,46));
    for (int column = 0; column < COLUMNS; column++) {
        if (!present[column]) continue;
        /* Preserve successful peaks in a grouped column; a failure adds only
         * a red baseline pixel, never an invented full-height latency bar. */
        int height = (int)lround(peaks[column] / ceiling * PLOT_HEIGHT);
        if (height < 1 && !lost[column]) height = 1;
        if (height > PLOT_HEIGHT) height = PLOT_HEIGHT;
        if (height > 0)
            fb_draw_rect(fb, MARGIN + column * 2, HEIGHT - MARGIN - height, 1, height, RGB565(99,222,176));
        if (lost[column])
            fb_put_pixel(fb, MARGIN + column * 2, HEIGHT - MARGIN - 1, RGB565(196,88,97));
    }
}

static void generate_sms(Framebuffer *fb, FT_Face face, unsigned page) {
    char sender[128], body[8193], lines[1024][256];
    if (!fgets(sender, sizeof(sender), stdin)) snprintf(sender, sizeof(sender), "SMS unavailable");
    sender[strcspn(sender, "\r\n")] = 0;
    size_t bytes = fread(body, 1, sizeof(body) - 1, stdin);
    body[bytes] = 0;
    while (bytes && (body[bytes-1] == '\n' || body[bytes-1] == '\r')) body[--bytes] = 0;
    if (!bytes) snprintf(body, sizeof(body), "No message text.");
    unsigned count = 0;
    const char *p = body;
    FT_Set_Pixel_Sizes(face, 0, 12);
    while (*p && count < 1024) {
        size_t len = 0, space_len = 0;
        int width = 0;
        const char *space_next = NULL;
        while (*p) {
            const char *start = p;
            unsigned long cp = utf8_next(&p);
            if (cp == '\r') continue;
            if (cp == '\n') break;
            int blank = cp == ' ' || cp == '\t' || cp < 32;
            if (!len && blank) continue;
            size_t n = blank ? 1 : (size_t)(p - start);
            FT_Load_Char(face, blank ? ' ' : cp, FT_LOAD_RENDER);
            int advance = face->glyph->advance.x >> 6;
            if (len && (width + advance > 120 || len + n >= sizeof(lines[0]))) {
                if (space_next) { len = space_len; p = space_next; }
                else p = start;
                break;
            }
            if (blank) { space_len = len; space_next = p; lines[count][len++] = ' '; }
            else { memcpy(lines[count] + len, start, n); len += n; }
            width += advance;
        }
        lines[count++][len] = 0;
    }
    unsigned pages = (count + 5) / 6;
    if (!pages) pages = 1;
    page %= pages;
    fb_init(fb);
    fb_draw_text(fb, face, "Latest SMS", 4, 13, 12);
    draw_fitted(fb, face, sender, 4, 29, 11, 120, 0);
    fb_draw_rect(fb, 4, 34, 120, 1, RGB565(65,80,95));
    for (unsigned row = 0; row < 6 && page * 6 + row < count; row++)
        fb_draw_text(fb, face, lines[page * 6 + row], 4, 49 + row * 12, 12);
    char footer[32];
    snprintf(footer, sizeof(footer), "%u/%u%s", page + 1, pages, pages > 1 ? "  auto" : "");
    fb_draw_text(fb, face, footer, 4, 124, 9);
}

void print_usage(const char *prog) {
    fprintf(stderr, "Usage: %s [OPTIONS]\n", prog);
    fprintf(stderr, "  -b NUM    Battery percentage (0-100)\n");
    fprintf(stderr, "  -c        Charging indicator (adds + prefix)\n");
    fprintf(stderr, "  -n NAME   Operator name\n");
    fprintf(stderr, "  -t TYPE   Network type (4G, LTE)\n");
    fprintf(stderr, "  -s SSID   WiFi SSID\n");
    fprintf(stderr, "  -p PASS   WiFi password\n");
    fprintf(stderr, "  -h HOST   Hostname\n");
    fprintf(stderr, "  -q        Show QR code (default: show logo)\n");
    fprintf(stderr, "  -u        Convert text to UPPERCASE\n");
    fprintf(stderr, "  -m        Latest SMS (sender then message on stdin)\n");
    fprintf(stderr, "  -j NUM    SMS page, cycles automatically\n");
    fprintf(stderr, "  -P        Ping history graph (timestamp/ms rows on stdin)\n");
    fprintf(stderr, "  -Z EPOCH   Fixed ping graph time for previews\n");
    fprintf(stderr, "  -a        Analog sleep clock with second hand\n");
    fprintf(stderr, "  -T TIME   Fixed HH:MM:SS clock time for previews\n");
    fprintf(stderr, "  -d        Dashboard (battery, signal, IMEI, phone)\n");
    fprintf(stderr, "  -e        Battery percentage is a voltage estimate\n");
    fprintf(stderr, "  -v NUM    Live traffic bar level (0-100; -1 unknown)\n");
    fprintf(stderr, "  -g NUM    Recent signal strength (0-100; -1 unknown)\n");
    fprintf(stderr, "  -N NUMBER SIM phone number\n");
    fprintf(stderr, "  -i IMEI   Current modem IMEI\n");
    fprintf(stderr, "  -r RATE   Download rate label\n");
    fprintf(stderr, "  -x RATE   Upload rate label\n");
    fprintf(stderr, "  -f NAME   Traffic interface label\n");
}


int main(int argc, char *argv[]) {
    DisplayConfig cfg = {
        .battery = 100,
        .clock_hour = -1,
        .charging = 0,       // NEW: default not charging
        .operator = "Unknown",
        .network_type = "4G",
        .ssid = "WiFi",
        .password = "password",
        .hostname = "Router",
        .show_qr = 0,
        .uppercase = 0,
        .signal = -1,
        .flow = -1,
        .download = "--",
        .upload = "--",
        .interface = "No interface"
    };
    
    int opt;
    while ((opt = getopt(argc, argv, "b:cn:t:s:p:h:qudei:g:r:x:f:aT:mj:N:v:PZ:")) != -1) {
        switch (opt) {
            case 'P': cfg.ping_history = 1; break;
            case 'Z': cfg.ping_now = (time_t)strtoll(optarg, NULL, 10); break;
            case 'm': cfg.sms = 1; break;
            case 'j': cfg.sms_page = (unsigned)strtoul(optarg, NULL, 10); break;
            case 'a': cfg.analog_clock = 1; break;
            case 'T': {
                char extra;
                if (sscanf(optarg,"%d:%d:%d%c",&cfg.clock_hour,&cfg.clock_minute,&cfg.clock_second,&extra)!=3 ||
                    cfg.clock_hour<0 || cfg.clock_hour>23 || cfg.clock_minute<0 || cfg.clock_minute>59 ||
                    cfg.clock_second<0 || cfg.clock_second>59) {
                    fprintf(stderr,"Invalid clock time; use HH:MM:SS\n"); return 1;
                }
                break;
            }
            case 'b': cfg.battery = atoi(optarg); break;
            case 'c': cfg.charging = 1; break;
            case 'n': snprintf(cfg.operator, sizeof(cfg.operator), "%s", optarg); break;
            case 't': snprintf(cfg.network_type, sizeof(cfg.network_type), "%s", optarg); break;
            case 's': snprintf(cfg.ssid, sizeof(cfg.ssid), "%s", optarg); break;
            case 'p': snprintf(cfg.password, sizeof(cfg.password), "%s", optarg); break;
            case 'h': snprintf(cfg.hostname, sizeof(cfg.hostname), "%s", optarg); break;
            case 'q': cfg.show_qr = 1; break;
            case 'u': cfg.uppercase = 1; break;
            case 'd': cfg.dashboard = 1; break;
            case 'e': cfg.battery_estimated = 1; break;
            case 'v': cfg.flow = atoi(optarg); break;
            case 'g': cfg.signal = atoi(optarg); break;
            case 'N': snprintf(cfg.phone, sizeof(cfg.phone), "%s", optarg); break;
            case 'i': snprintf(cfg.imei, sizeof(cfg.imei), "%s", optarg); break;
            case 'r': snprintf(cfg.download, sizeof(cfg.download), "%s", optarg); break;
            case 'x': snprintf(cfg.upload, sizeof(cfg.upload), "%s", optarg); break;
            case 'f': snprintf(cfg.interface, sizeof(cfg.interface), "%s", optarg); break;
            default:
                print_usage(argv[0]);
                return 1;
        }
    }
    
    if (cfg.battery < 0) cfg.battery = -1;
    if (cfg.battery > 100) cfg.battery = 100;
    if (cfg.signal < 0) cfg.signal = -1;
    if (cfg.signal > 100) cfg.signal = 100;
    if (cfg.flow < 0) cfg.flow = -1;
    if (cfg.flow > 100) cfg.flow = 100;

    FT_Library ft;
    if (FT_Init_FreeType(&ft)) {
        fprintf(stderr, "FreeType init failed\n");
        return 1;
    }
    
    FT_Face face;
    const char *fonts[] = {
        "/usr/share/fonts/ttf-dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/ttf-dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        NULL
    };
    
    int found = 0;
    for (int i = 0; fonts[i]; i++) {
        if (FT_New_Face(ft, fonts[i], 0, &face) == 0) {
            found = 1;
            break;
        }
    }
    
    if (!found) {
        fprintf(stderr, "No font found\n");
        FT_Done_FreeType(ft);
        return 1;
    }
    
    Framebuffer fb;
    if (cfg.ping_history) generate_ping(&fb, face, cfg.ping_now ? cfg.ping_now : time(NULL));
    else if (cfg.sms) generate_sms(&fb, face, cfg.sms_page);
    else if (cfg.analog_clock) generate_clock(&fb, &cfg, face);
    else generate_display(&fb, &cfg, face);
    
    if (fwrite(fb.data, sizeof(uint16_t), WIDTH * HEIGHT, stdout) != WIDTH * HEIGHT) {
        fprintf(stderr, "Framebuffer output failed\n");
        FT_Done_Face(face);
        FT_Done_FreeType(ft);
        return 1;
    }
    
    FT_Done_Face(face);
    FT_Done_FreeType(ft);
    
    return 0;
}
