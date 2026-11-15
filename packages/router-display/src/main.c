#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <getopt.h>
#include <unistd.h>
#include <ctype.h>
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
    int battery_estimated;
    int signal;
    char imei[16];
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

void fb_draw_text(Framebuffer *fb, FT_Face face, const char *text, int x, int y, int size) {
    int pen_x = x;
    
    for (const char *p = text; *p; p++) {
        FT_Set_Pixel_Sizes(face, 0, size);
        
        if (FT_Load_Char(face, *p, FT_LOAD_RENDER | FT_LOAD_TARGET_NORMAL)) {
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
    
    for (const char *p = text; *p; p++) {
        if (FT_Load_Char(face, *p, FT_LOAD_RENDER)) {
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

static void generate_dashboard(Framebuffer *fb, DisplayConfig *cfg, FT_Face face) {
    fb_init(fb);
    fb_draw_rect(fb, 0, 0, WIDTH, 19, RGB565(25, 55, 91));
    fb_draw_text(fb, face, "MiFi", 5, 14, 12);
    char text[32];
    if (cfg->battery < 0)
        snprintf(text, sizeof(text), "--");
    else
        snprintf(text, sizeof(text), "%s%s%d%%", cfg->charging ? "+" : "",
                 cfg->battery_estimated ? "~" : "", cfg->battery);
    draw_fitted(fb, face, text, 43, 13, 10, 59, 1);
    fb_draw_rect(fb, 107, 5, 15, 9, COLOR_WHITE);
    fb_draw_rect(fb, 109, 7, 11, 5, RGB565(25, 55, 91));
    fb_draw_rect(fb, 122, 8, 2, 3, COLOR_WHITE);
    if (cfg->battery >= 0) {
        uint16_t color = cfg->battery <= 15 ? RGB565(255, 120, 105) : RGB565(99, 222, 176);
        fb_draw_rect(fb, 109, 7, (11 * cfg->battery + 99) / 100, 5, color);
    }
    int bars = cfg->signal < 0 ? 0 : (cfg->signal + 24) / 25;
    for (int i = 0; i < 4; i++) {
        int height = 4 + i * 3;
        fb_draw_rect(fb, 6 + i * 6, 35 - height, 4, height,
                     i < bars ? RGB565(99, 222, 176) : RGB565(54, 65, 80));
    }
    if (cfg->signal < 0) snprintf(text, sizeof(text), "--");
    else snprintf(text, sizeof(text), "%d%%", cfg->signal);
    fb_draw_text(fb, face, text, 35, 34, 10);
    draw_fitted(fb, face, cfg->network_type, 77, 34, 10, 46, 1);
    draw_fitted(fb, face, cfg->operator, 6, 49, 10, 116, 0);
    fb_draw_rect(fb, 6, 55, 116, 1, RGB565(45, 63, 85));
    fb_draw_text(fb, face, "IMEI", 6, 63, 8);
    /* Two rows keep all 15 digits readable on the narrow physical panel. */
    const char *imei = cfg->imei[0] ? cfg->imei : "Unavailable";
    char imei_top[9], imei_bottom[9];
    int split_imei = strlen(imei) == 15 && strspn(imei, "0123456789") == 15;
    snprintf(imei_top, sizeof(imei_top), "%.8s", imei);
    snprintf(imei_bottom, sizeof(imei_bottom), "%s", split_imei ? imei + 8 : "");
    const char *first_row = split_imei ? imei_top : imei;
    int imei_size = 22;
    while (imei_size > 1 &&
           (fb_get_text_width(face, first_row, imei_size) > WIDTH - 8 ||
            fb_get_text_width(face, imei_bottom, imei_size) > WIDTH - 8))
        imei_size--;
    int imei_width = fb_get_text_width(face, first_row, imei_size);
    fb_draw_text(fb, face, first_row, (WIDTH - imei_width) / 2,
                 split_imei ? 82 : 91, imei_size);
    if (split_imei) {
        imei_width = fb_get_text_width(face, imei_bottom, imei_size);
        fb_draw_text(fb, face, imei_bottom, (WIDTH - imei_width) / 2, 104, imei_size);
    }
    fb_draw_text(fb, face, "DL", 6, 116, 9);
    draw_fitted(fb, face, cfg->download, 27, 116, 10, 95, 1);
    fb_draw_text(fb, face, "UL", 6, 127, 9);
    draw_fitted(fb, face, cfg->upload, 27, 127, 10, 95, 1);
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
    fprintf(stderr, "  -d        Dashboard (battery, signal, IMEI, transfer rates)\n");
    fprintf(stderr, "  -e        Battery percentage is a voltage estimate\n");
    fprintf(stderr, "  -g NUM    Recent signal strength (0-100; -1 unknown)\n");
    fprintf(stderr, "  -i IMEI   Current modem IMEI\n");
    fprintf(stderr, "  -r RATE   Download rate label\n");
    fprintf(stderr, "  -x RATE   Upload rate label\n");
    fprintf(stderr, "  -f NAME   Traffic interface label\n");
}


int main(int argc, char *argv[]) {
    DisplayConfig cfg = {
        .battery = 100,
        .charging = 0,       // NEW: default not charging
        .operator = "Unknown",
        .network_type = "4G",
        .ssid = "WiFi",
        .password = "password",
        .hostname = "Router",
        .show_qr = 0,
        .uppercase = 0,
        .signal = -1,
        .download = "--",
        .upload = "--",
        .interface = "No interface"
    };
    
    int opt;
    while ((opt = getopt(argc, argv, "b:cn:t:s:p:h:qudei:g:r:x:f:")) != -1) {
        switch (opt) {
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
            case 'g': cfg.signal = atoi(optarg); break;
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
    generate_display(&fb, &cfg, face);
    
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
