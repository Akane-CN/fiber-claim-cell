TARGET := riscv64imac-unknown-none-elf
RUSTFLAGS_CONTRACT := -C target-feature=+zba,+zbb,+zbc,+zbs,-a
BUILD_DIR := build/release

.PHONY: build test clean

build:
	cd contracts/async-claim-lock && \
		RUSTFLAGS="$(RUSTFLAGS_CONTRACT)" cargo build --release --target $(TARGET)
	mkdir -p $(BUILD_DIR)
	cp contracts/async-claim-lock/target/$(TARGET)/release/async-claim-lock $(BUILD_DIR)/

test: build
	cd tests && cargo test

clean:
	rm -rf build contracts/async-claim-lock/target tests/target
