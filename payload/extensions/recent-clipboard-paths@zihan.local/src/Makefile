# Rebuild with: make -C src   (output: ../libmultisource.so)
CFLAGS ?= -O2 -g -Wall -Wextra -Wno-unused-parameter

../libmultisource.so: multisource.c
	$(CC) $(CFLAGS) -shared -fPIC -o $@ $< $$(pkg-config --cflags --libs gio-2.0)
