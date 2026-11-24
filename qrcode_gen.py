"""Dependency-free QR Code encoder used for printed receipts.

The POS runs on a locked-down shop machine with no internet access, so the code
has to be produced locally instead of pulling a library or an image service.
Only what a receipt actually needs is implemented: byte mode, error correction
level M, versions 1-10 (up to ~210 bytes), and the standard mask evaluation.
"""

# Version -> [(block count, total codewords, data codewords)] for ECC level M.
_BLOCKS_M = {
    1: [(1, 26, 16)],
    2: [(1, 44, 28)],
    3: [(1, 70, 44)],
    4: [(2, 50, 32)],
    5: [(2, 67, 43)],
    6: [(4, 43, 27)],
    7: [(4, 49, 31)],
    8: [(2, 60, 38), (2, 61, 39)],
    9: [(3, 58, 36), (2, 59, 37)],
    10: [(4, 69, 43), (1, 70, 44)],
}

_ALIGNMENT_CENTERS = {
    1: [],
    2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
    7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
}

# 18-bit version information strings (6-bit version + 12-bit BCH remainder).
_VERSION_INFO = {7: 0x07C94, 8: 0x085BC, 9: 0x09A99, 10: 0x0A4D3}

_MAX_VERSION = 10
_ECC_FORMAT_BITS = 0b00  # Level M.
_FORMAT_MASK = 0x5412

_EXP = [0] * 512
_LOG = [0] * 256


def _init_fields():
    value = 1
    for index in range(255):
        _EXP[index] = value
        _LOG[value] = index
        value <<= 1
        if value & 0x100:
            value ^= 0x11D
    for index in range(255, 512):
        _EXP[index] = _EXP[index - 255]


_init_fields()


def _multiply(first, second):
    if first == 0 or second == 0:
        return 0
    return _EXP[_LOG[first] + _LOG[second]]


def _polynomial_multiply(first, second):
    product = [0] * (len(first) + len(second) - 1)
    for i, left in enumerate(first):
        if not left:
            continue
        for j, right in enumerate(second):
            if right:
                product[i + j] ^= _multiply(left, right)
    return product


def _generator_polynomial(degree):
    generator = [1]
    for power in range(degree):
        generator = _polynomial_multiply(generator, [1, _EXP[power]])
    return generator


def _reed_solomon(data, degree):
    generator = _generator_polynomial(degree)
    message = list(data) + [0] * degree
    for index in range(len(data)):
        # The coefficient must be read back from the running remainder: the
        # reduction of earlier positions changes this byte.
        coefficient = message[index]
        if not coefficient:
            continue
        for offset, term in enumerate(generator):
            message[index + offset] ^= _multiply(term, coefficient)
    return message[len(data):]


def _data_codeword_count(version):
    return sum(count * data for count, _total, data in _BLOCKS_M[version])


def _fits_version(version, payload_length):
    header = 4 + (16 if version >= 10 else 8)
    return _data_codeword_count(version) * 8 >= header + payload_length * 8


def _choose_version(payload_length):
    for version in range(1, _MAX_VERSION + 1):
        if _fits_version(version, payload_length):
            return version
    raise ValueError("النص أطول مما يستوعبه مولّد الكيو ار كود.")


def _encode_payload(version, payload):
    bits = []

    def push(value, length):
        for shift in range(length - 1, -1, -1):
            bits.append((value >> shift) & 1)

    push(4, 4)  # Byte mode.
    push(len(payload), 16 if version >= 10 else 8)
    for byte in payload:
        push(byte, 8)

    capacity = _data_codeword_count(version) * 8
    push(0, min(4, capacity - len(bits)))
    while len(bits) % 8:
        bits.append(0)

    codewords = []
    for start in range(0, len(bits), 8):
        byte = 0
        for bit in bits[start:start + 8]:
            byte = (byte << 1) | bit
        codewords.append(byte)

    padding = [0xEC, 0x11]
    index = 0
    while len(codewords) < _data_codeword_count(version):
        codewords.append(padding[index % 2])
        index += 1
    return codewords


def _interleave(version, codewords):
    data_blocks = []
    ec_blocks = []
    cursor = 0
    for count, total, data_length in _BLOCKS_M[version]:
        for _ in range(count):
            chunk = codewords[cursor:cursor + data_length]
            cursor += data_length
            data_blocks.append(chunk)
            ec_blocks.append(_reed_solomon(chunk, total - data_length))

    stream = []
    for offset in range(max(len(block) for block in data_blocks)):
        for block in data_blocks:
            if offset < len(block):
                stream.append(block[offset])
    for offset in range(max(len(block) for block in ec_blocks)):
        for block in ec_blocks:
            if offset < len(block):
                stream.append(block[offset])
    return stream


def _bits(value, length):
    return [(value >> shift) & 1 for shift in range(length - 1, -1, -1)]


def _new_grid(version):
    size = version * 4 + 17
    modules = [[0] * size for _ in range(size)]
    reserved = [[False] * size for _ in range(size)]

    def stamp(row, column, dark):
        if 0 <= row < size and 0 <= column < size:
            modules[row][column] = 1 if dark else 0
            reserved[row][column] = True

    for row_center, column_center in ((0, 0), (0, size - 7), (size - 7, 0)):
        for row in range(-1, 8):
            for column in range(-1, 8):
                # The seventh row/column of the loop is the light separator.
                distance = max(abs(row - 3), abs(column - 3))
                inside = 0 <= row < 7 and 0 <= column < 7
                stamp(row_center + row, column_center + column, inside and distance != 2)

    # The timing patterns stop at the separators; stamping across them would
    # erase the finder edges that were laid down above.
    for index in range(8, size - 8):
        stamp(6, index, index % 2 == 0)
        stamp(index, 6, index % 2 == 0)

    centers = _ALIGNMENT_CENTERS[version]
    if centers:
        outer = centers[-1]
        for row in centers:
            for column in centers:
                # Only the three corners that would sit on a finder are dropped.
                # The centres that cross the timing pattern are stamped anyway.
                if (row, column) in ((6, 6), (6, outer), (outer, 6)):
                    continue
                for offset_row in range(-2, 3):
                    for offset_column in range(-2, 3):
                        distance = max(abs(offset_row), abs(offset_column))
                        stamp(row + offset_row, column + offset_column, distance != 1)

    if version >= 7:
        value = _VERSION_INFO[version]
        for index in range(18):
            bit = (value >> index) & 1
            # Two 3x6 blocks mirrored across the diagonal: the tall one hugs the
            # top right finder, the wide one hugs the bottom left finder.
            near = size - 11 + index % 3
            far = index // 3
            stamp(far, near, bit)
            stamp(near, far, bit)

    # Reserve both format-information copies; the bits are written once the
    # winning mask is known.
    for index in range(9):
        reserved[8][index] = True
        reserved[index][8] = True
    for index in range(8):
        reserved[8][size - 1 - index] = True
        reserved[size - 1 - index][8] = True
    reserved[size - 8][8] = True  # The permanently dark module.
    return modules, reserved


def _place_data(modules, reserved, stream):
    size = len(modules)
    bits = []
    for byte in stream:
        bits.extend(_bits(byte, 8))
    index = 0
    upward = True
    column = size - 1
    while column > 0:
        if column == 6:
            column -= 1  # The vertical timing pattern owns column 6.
        for step in range(size):
            row = size - 1 - step if upward else step
            for offset in range(2):
                if not reserved[row][column - offset] and index < len(bits):
                    modules[row][column - offset] = bits[index]
                    index += 1
        upward = not upward
        column -= 2
    return modules


_MASK_FUNCTIONS = [
    lambda row, column: (row + column) % 2 == 0,
    lambda row, column: row % 2 == 0,
    lambda row, column: column % 3 == 0,
    lambda row, column: (row + column) % 3 == 0,
    lambda row, column: (row // 2 + column // 3) % 2 == 0,
    lambda row, column: (row * column) % 2 + (row * column) % 3 == 0,
    lambda row, column: ((row * column) % 2 + (row * column) % 3) % 2 == 0,
    lambda row, column: ((row + column) % 2 + (row * column) % 3) % 2 == 0,
]


def _apply_mask(modules, reserved, index):
    size = len(modules)
    masked = [row[:] for row in modules]
    function = _MASK_FUNCTIONS[index]
    for row in range(size):
        for column in range(size):
            if not reserved[row][column] and function(row, column):
                masked[row][column] ^= 1
    return masked


def _write_format(modules, mask_index):
    size = len(modules)
    payload = (_ECC_FORMAT_BITS << 3) | mask_index
    remainder = payload << 10
    for shift in range(14, 9, -1):
        if (remainder >> shift) & 1:
            remainder ^= 0b10100110111 << (shift - 10)
    # Least significant bit first: the standard numbers the format bits from the
    # bottom up, while the placement walks outward from the center.
    value = (payload << 10 | remainder) ^ _FORMAT_MASK
    bits = [(value >> shift) & 1 for shift in range(15)]

    for index in range(6):
        modules[index][8] = bits[index]
    modules[7][8] = bits[6]
    modules[8][8] = bits[7]
    modules[8][7] = bits[8]
    for index in range(9, 15):
        modules[8][14 - index] = bits[index]
    for index in range(8):
        modules[8][size - 1 - index] = bits[index]
    for index in range(8, 15):
        modules[size - 15 + index][8] = bits[index]
    modules[size - 8][8] = 1
    return modules


def _penalty(modules):
    size = len(modules)
    score = 0

    for line_index in range(size):
        for direction in ("row", "column"):
            previous = None
            run = 0
            window = []
            for index in range(size):
                value = modules[line_index][index] if direction == "row" else modules[index][line_index]
                if value == previous:
                    run += 1
                else:
                    if run >= 5:
                        score += 3 + (run - 5)
                    run = 1
                    previous = value
                window.append(value)
                if len(window) > 7:
                    window.pop(0)
                if len(window) == 7:
                    if window == [1, 0, 1, 1, 1, 0, 1]:
                        score += 40
            if run >= 5:
                score += 3 + (run - 5)

    for row in range(size - 1):
        for column in range(size - 1):
            corner = modules[row][column]
            if corner == modules[row][column + 1] == modules[row + 1][column] == modules[row + 1][column + 1]:
                score += 3

    dark = sum(sum(row) for row in modules)
    percent = dark * 100 // (size * size)
    score += abs(percent - 50) // 5 * 10
    return score


def make_qr_matrix(text):
    """Return the square module grid (1 = dark) for the given text."""
    payload = str(text or "").encode("utf-8")
    version = _choose_version(len(payload))
    modules, reserved = _new_grid(version)
    modules = _place_data(modules, reserved, _interleave(version, _encode_payload(version, payload)))

    best, best_score = None, None
    for mask_index in range(8):
        candidate = _write_format(_apply_mask(modules, reserved, mask_index), mask_index)
        score = _penalty(candidate)
        if best_score is None or score < best_score:
            best, best_score = candidate, score
    return best


def quiet_zone(matrix, modules=2):
    """Wrap the grid in a light border so the code stays scannable."""
    size = len(matrix)
    edge = size + modules * 2
    framed = [[0] * edge for _ in range(edge)]
    for row in range(size):
        for column in range(size):
            framed[row + modules][column + modules] = matrix[row][column]
    return framed


def qr_html_table(text, cell_px=3, quiet_modules=2):
    """Render the code as a table of cells sized in pixels.

    A table of fixed-size cells prints identically on every engine the shop
    machine might use, including the legacy IE rendering shell, where SVG and
    canvas are unreliable.
    """
    try:
        matrix = quiet_zone(make_qr_matrix(text), quiet_modules)
    except ValueError:
        return ""
    style = "width:%gpx;height:%gpx;" % (cell_px, cell_px)
    rows = []
    for row in matrix:
        cells = [
            '<td style="padding:0; margin:0; %s%s"></td>' % (
                style,
                "background:#000;" if value else "background:#fff;",
            )
            for value in row
        ]
        rows.append('<tr style="line-height:0;font-size:0;">%s</tr>' % "".join(cells))
    return (
        '<table role="img" aria-label="QR" style="border-collapse:collapse;margin:6px auto;">'
        + "".join(rows) + "</table>"
    )
