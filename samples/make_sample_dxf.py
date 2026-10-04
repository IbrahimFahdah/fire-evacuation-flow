import os
"""Generate a sample typical office floor plate (Level 03) as DXF, in millimetres.
Built for testing the Evacuation Flow app: walls, doors (as blocks), fire stairs,
exit signs, labels and furniture all sit on conventional AIA-style layers."""
import math
import ezdxf
from ezdxf.enums import TextEntityAlignment

doc = ezdxf.new("R2018", setup=True)
doc.header["$INSUNITS"] = 4  # millimetres
doc.header["$MEASUREMENT"] = 1
msp = doc.modelspace()

LAYERS = {
    "A-WALL-EXTR": (7, "Exterior walls"),
    "A-WALL-INTR": (8, "Interior partitions"),
    "A-WALL-FIRE": (1, "Fire-rated walls (stair / core enclosures)"),
    "A-WALL-PATT": (253, "Wall solid fill"),
    "A-GLAZ": (4, "Glazed partitions"),
    "A-DOOR": (3, "Doors"),
    "A-DOOR-FIRE": (1, "Fire-rated doors"),
    "A-STAIR": (5, "Stairs"),
    "A-FLOR-LIFT": (8, "Lift shafts"),
    "A-FURN": (9, "Loose furniture"),
    "A-FLOR-FIXT": (8, "Sanitary fixtures"),
    "S-COLS": (6, "Structural columns"),
    "A-GRID": (252, "Structural grid"),
    "A-ANNO-TEXT": (7, "Room names"),
    "A-ANNO-DIMS": (2, "Dimensions"),
    "A-ANNO-TTLB": (7, "Title block"),
    "F-EXIT": (1, "Exit signage"),
}
for name, (color, desc) in LAYERS.items():
    lay = doc.layers.add(name, color=color)
    lay.description = desc
doc.linetypes.add("CENTER", pattern=[2.0, 1.25, -0.25, 0.25, -0.25], description="Center ____ _ ____")
doc.layers.get("A-GRID").dxf.linetype = "CENTER"

# ---------------------------------------------------------------- blocks
def make_door_blocks():
    b = doc.blocks.new("DOOR_SINGLE")  # unit width 1, hinge at origin, opening along +x, swings to +y
    b.add_line((0, 0), (0, 1))
    b.add_arc((0, 0), 1, 0, 90)
    b = doc.blocks.new("DOOR_DOUBLE")
    b.add_line((0, 0), (0, 0.5)); b.add_arc((0, 0), 0.5, 0, 90)
    b.add_line((1, 0), (1, 0.5)); b.add_arc((1, 0), 0.5, 90, 180)
    b = doc.blocks.new("DOOR_FIRE_SINGLE")
    b.add_line((0, 0), (0, 1)); b.add_arc((0, 0), 1, 0, 90)
    b.add_attdef("FIRE_RATING", insert=(0.1, 0.1), dxfattribs={"height": 0.08}).dxf.invisible = 1
    b.add_attdef("DOOR_ID", insert=(0.1, 0.25), dxfattribs={"height": 0.08}).dxf.invisible = 1
    b = doc.blocks.new("EXIT_SIGN")
    b.add_lwpolyline([(-450, -150), (450, -150), (450, 150), (-450, 150)], close=True)
    b.add_text("EXIT", height=160, dxfattribs={"style": "OpenSans"}).set_placement((0, 0), align=TextEntityAlignment.MIDDLE_CENTER)
    b = doc.blocks.new("DESK_1600")
    b.add_lwpolyline([(0, 0), (1600, 0), (1600, 800), (0, 800)], close=True)
    b.add_circle((800, 1150), 280)  # chair
    b = doc.blocks.new("WC")
    b.add_lwpolyline([(-200, 0), (200, 0), (200, 200), (-200, 200)], close=True)
    b.add_ellipse((0, 450), major_axis=(0, 250), ratio=0.75)
    b = doc.blocks.new("BASIN")
    b.add_lwpolyline([(-300, 0), (300, 0), (300, 450), (-300, 450)], close=True)
    b.add_ellipse((0, 220), major_axis=(200, 0), ratio=0.7)
make_door_blocks()

# ---------------------------------------------------------------- walls
walls = []  # dict(a, b, t, layer, openings=[(start_offset, width)])

def wall(a, b, t, layer, openings=()):
    walls.append(dict(a=a, b=b, t=t, layer=layer, openings=list(openings)))

def emit_walls():
    for w in walls:
        (x1, y1), (x2, y2) = w["a"], w["b"]
        L = math.hypot(x2 - x1, y2 - y1)
        ux, uy = (x2 - x1) / L, (y2 - y1) / L
        nx, ny = -uy, ux
        h = w["t"] / 2
        cuts = sorted(w["openings"])
        pieces, s = [], 0.0
        for o, wd in cuts:
            if o > s: pieces.append((s, o))
            s = o + wd
        if s < L: pieces.append((s, L))
        # extend pieces at the true ends by half thickness so corners close
        for s0, s1 in pieces:
            e0 = -h if s0 == 0 else 0
            e1 = h if abs(s1 - L) < 1e-6 else 0
            p0 = (x1 + ux * (s0 + e0), y1 + uy * (s0 + e0))
            p1 = (x1 + ux * (s1 + e1), y1 + uy * (s1 + e1))
            pts = [(p0[0] + nx * h, p0[1] + ny * h), (p1[0] + nx * h, p1[1] + ny * h),
                   (p1[0] - nx * h, p1[1] - ny * h), (p0[0] - nx * h, p0[1] - ny * h)]
            if w["layer"] == "A-GLAZ":
                msp.add_lwpolyline(pts, close=True, dxfattribs={"layer": "A-GLAZ"})
                msp.add_line(((pts[0][0] + pts[3][0]) / 2, (pts[0][1] + pts[3][1]) / 2),
                             ((pts[1][0] + pts[2][0]) / 2, (pts[1][1] + pts[2][1]) / 2), dxfattribs={"layer": "A-GLAZ"})
                continue
            msp.add_lwpolyline(pts, close=True, dxfattribs={"layer": w["layer"]})
            hatch = msp.add_hatch(color=253, dxfattribs={"layer": "A-WALL-PATT"})
            hatch.paths.add_polyline_path(pts, is_closed=True)

def door(block, hinge, along, swing, width, layer="A-DOOR", attribs=None):
    """hinge: point; along: unit vector of opening; swing: unit normal side the leaf opens to."""
    ang = math.degrees(math.atan2(along[1], along[0]))
    left = (-along[1], along[0])
    ys = 1 if (left[0] * swing[0] + left[1] * swing[1]) > 0 else -1
    ref = msp.add_blockref(block, hinge, dxfattribs={"layer": layer, "rotation": ang,
                                                     "xscale": width, "yscale": width * ys})
    if attribs:
        ref.add_auto_attribs(attribs)
    return ref

W, H = 48000, 24000
EXT, INT, FIRE = 300, 120, 200

# exterior shell (curtain wall assumed solid for egress)
wall((0, 0), (W, 0), EXT, "A-WALL-EXTR")
wall((W, 0), (W, H), EXT, "A-WALL-EXTR")
wall((W, H), (0, H), EXT, "A-WALL-EXTR")
wall((0, H), (0, 0), EXT, "A-WALL-EXTR")

# --- south strip of cellular rooms (y 0..6500), corridor y 6500..8500
rooms_x = [0, 6000, 10000, 14000, 20000, 28000, 34000, 38000, 42000, 48000]
room_names = ["OFFICE 301", "OFFICE 302", "OFFICE 303", "MEETING 304", "PANTRY / COPY 305",
              "MEETING 306", "OFFICE 307", "OFFICE 308", "OFFICE 309"]
corr_s = 6500
south_door_offsets = []
for i in range(len(rooms_x) - 1):
    x0, x1 = rooms_x[i], rooms_x[i + 1]
    dw = 1000 if room_names[i].startswith(("MEETING", "PANTRY")) else 900
    dx = max(x1 - 400 - dw, 3800) if x1 > 4400 else None
    if i == 0:
        dx = 4600
    if i == len(rooms_x) - 2:
        dx = 42600
    south_door_offsets.append((dx, dw))
    if 0 < i:
        wall((x0, 0), (x0, corr_s), INT, "A-WALL-INTR")
# corridor south wall with room doors (offset measured from x=0 along +x)
wall((0, corr_s), (W, corr_s), INT, "A-WALL-INTR", openings=[(dx, dw) for dx, dw in south_door_offsets])
for dx, dw in south_door_offsets:
    door("DOOR_SINGLE", (dx, corr_s), (1, 0), (0, -1), dw)

# --- fire stairs at each end (x 0..3600 / 44400..48000, y 6500..12500)
ST_W, ST_Y0, ST_Y1 = 3600, 6500, 12500
stair_door = (7000, 1000)  # y offset, width
for side, x_in in (("W", ST_W), ("E", W - ST_W)):
    # inner enclosure wall with fire door onto corridor
    wall((x_in, ST_Y0), (x_in, ST_Y1), FIRE, "A-WALL-FIRE",
         openings=[(stair_door[0] - ST_Y0, stair_door[1])])
    x_out = 0 if side == "W" else W
    wall((x_out, ST_Y1), (x_in, ST_Y1), FIRE, "A-WALL-FIRE")
    wall((x_out, ST_Y0), (x_in, ST_Y0), FIRE, "A-WALL-FIRE")
    sid = "1" if side == "W" else "2"
    into = (-1, 0) if side == "W" else (1, 0)
    door("DOOR_FIRE_SINGLE", (x_in, stair_door[0]), (0, 1), into, stair_door[1], layer="A-DOOR-FIRE",
         attribs={"FIRE_RATING": "FD60S", "DOOR_ID": f"ST{sid}-D01"})
    # stair geometry: two flights + landing
    xa, xb = (300, x_in - 100) if side == "W" else (x_in + 100, W - 300)
    mid = (xa + xb) / 2
    fy0, fy1 = ST_Y0 + 1700, ST_Y1 - 1400
    for y in range(int(fy0), int(fy1) + 1, 280):
        msp.add_line((xa, y), (xb, y), dxfattribs={"layer": "A-STAIR"})
    msp.add_lwpolyline([(mid - 75, fy0), (mid + 75, fy0), (mid + 75, fy1), (mid - 75, fy1)], close=True,
                       dxfattribs={"layer": "A-STAIR"})
    # direction arrows + cut line
    for xm, label, d in (((xa + mid) / 2, "DN", -1), ((mid + xb) / 2, "UP", 1)):
        ys, ye = (fy1 - 200, fy0 + 300) if d < 0 else (fy0 + 200, fy1 - 300)
        msp.add_line((xm, ys), (xm, ye), dxfattribs={"layer": "A-STAIR"})
        msp.add_lwpolyline([(xm - 120, ye - d * 250), (xm, ye), (xm + 120, ye - d * 250)], dxfattribs={"layer": "A-STAIR"})
        msp.add_text(label, height=180, dxfattribs={"layer": "A-STAIR"}).set_placement(
            (xm + 150, (fy0 + fy1) / 2), align=TextEntityAlignment.MIDDLE_LEFT)
    msp.add_line((xa, fy1 - 900), (xb, fy1 - 500), dxfattribs={"layer": "A-STAIR"})
    msp.add_text(f"STAIR {sid}", height=250, dxfattribs={"layer": "A-ANNO-TEXT"}).set_placement(
        ((xa + xb) / 2, ST_Y1 - 600), align=TextEntityAlignment.MIDDLE_CENTER)
    msp.add_text("FIRE ESCAPE", height=180, dxfattribs={"layer": "A-ANNO-TEXT"}).set_placement(
        ((xa + xb) / 2, ST_Y1 - 950), align=TextEntityAlignment.MIDDLE_CENTER)
    # exit sign above door on corridor side
    sx = x_in + 700 if side == "W" else x_in - 700
    msp.add_blockref("EXIT_SIGN", (sx, stair_door[0] + stair_door[1] + 350), dxfattribs={"layer": "F-EXIT"})

# --- corridor north wall with double doors into open plan; gap for core
CORE_X0, CORE_X1, CORE_Y1 = 19000, 29000, 14500
corr_n = 8500
wall((ST_W, corr_n), (CORE_X0, corr_n), INT, "A-GLAZ", openings=[(9000 - ST_W, 1800)])
wall((CORE_X1, corr_n), (W - ST_W, corr_n), INT, "A-GLAZ", openings=[(37200 - CORE_X1, 1800)])
door("DOOR_DOUBLE", (9000, corr_n), (1, 0), (0, -1), 1800)
door("DOOR_DOUBLE", (37200, corr_n), (1, 0), (0, -1), 1800)

# --- central core: WC M, WC F, lifts + riser (all fire-rated enclosure)
wall((CORE_X0, corr_n), (CORE_X1, corr_n), FIRE, "A-WALL-FIRE",
     openings=[(20600 - CORE_X0, 900), (23600 - CORE_X0, 900)])
wall((CORE_X0, corr_n), (CORE_X0, CORE_Y1), FIRE, "A-WALL-FIRE")
wall((CORE_X1, corr_n), (CORE_X1, CORE_Y1), FIRE, "A-WALL-FIRE")
wall((CORE_X0, CORE_Y1), (CORE_X1, CORE_Y1), FIRE, "A-WALL-FIRE")
wall((22000, corr_n), (22000, CORE_Y1), FIRE, "A-WALL-FIRE")
wall((25000, corr_n), (25000, CORE_Y1), FIRE, "A-WALL-FIRE")
door("DOOR_SINGLE", (20600, corr_n), (1, 0), (0, 1), 900)
door("DOOR_SINGLE", (23600, corr_n), (1, 0), (0, 1), 900)
for i, x in enumerate((19500, 20500, 21500)):
    msp.add_blockref("WC", (x, CORE_Y1 - 100), dxfattribs={"layer": "A-FLOR-FIXT", "rotation": 180})
    msp.add_blockref("WC", (x + 3000, CORE_Y1 - 100), dxfattribs={"layer": "A-FLOR-FIXT", "rotation": 180})
for x in (19300, 22300):
    for y in (10200, 11200):
        msp.add_blockref("BASIN", (x, y), dxfattribs={"layer": "A-FLOR-FIXT", "rotation": -90})
# lifts: 3 shafts on north side of core, riser to the south
for i in range(3):
    x0 = 25200 + i * 1250
    pts = [(x0, 12000), (x0 + 1150, 12000), (x0 + 1150, 14400), (x0, 14400)]
    msp.add_lwpolyline(pts, close=True, dxfattribs={"layer": "A-FLOR-LIFT"})
    msp.add_line(pts[0], pts[2], dxfattribs={"layer": "A-FLOR-LIFT"})
    msp.add_line(pts[1], pts[3], dxfattribs={"layer": "A-FLOR-LIFT"})
wall((25000, 11900), (CORE_X1, 11900), FIRE, "A-WALL-FIRE")
msp.add_text("LIFTS", height=220, dxfattribs={"layer": "A-ANNO-TEXT"}).set_placement((27000, 11500), align=TextEntityAlignment.MIDDLE_CENTER)
msp.add_text("(NOT FOR EVACUATION)", height=150, dxfattribs={"layer": "A-ANNO-TEXT"}).set_placement((27000, 11150), align=TextEntityAlignment.MIDDLE_CENTER)
msp.add_text("RISER", height=200, dxfattribs={"layer": "A-ANNO-TEXT"}).set_placement((27000, 9600), align=TextEntityAlignment.MIDDLE_CENTER)

# --- boardroom (NE) and meeting room (NW)
wall((38000, 17000), (38000, H), INT, "A-GLAZ")
wall((38000, 17000), (W, 17000), INT, "A-GLAZ", openings=[(1000, 1200)])
door("DOOR_SINGLE", (39000, 17000), (1, 0), (0, -1), 1200)
wall((6000, 18000), (6000, H), INT, "A-GLAZ")
wall((0, 18000), (6000, 18000), INT, "A-GLAZ", openings=[(4600, 900)])
door("DOOR_SINGLE", (4600, 18000), (1, 0), (0, 1), 900)

emit_walls()

# ---------------------------------------------------------------- columns & grid
grid_x = list(range(0, W + 1, 8000))
grid_y = [0, 16000, H]
for x in grid_x:
    msp.add_line((x, -2500), (x, H + 2500), dxfattribs={"layer": "A-GRID"})
    msp.add_circle((x, H + 3100), 600, dxfattribs={"layer": "A-GRID"})
    msp.add_text(str(grid_x.index(x) + 1), height=500, dxfattribs={"layer": "A-GRID"}).set_placement((x, H + 3100), align=TextEntityAlignment.MIDDLE_CENTER)
for j, y in enumerate(grid_y):
    msp.add_line((-2500, y), (W + 2500, y), dxfattribs={"layer": "A-GRID"})
    msp.add_circle((-3100, y), 600, dxfattribs={"layer": "A-GRID"})
    msp.add_text("ABC"[j], height=500, dxfattribs={"layer": "A-GRID"}).set_placement((-3100, y), align=TextEntityAlignment.MIDDLE_CENTER)
columns = []
for x in grid_x:
    for y in grid_y:
        columns.append((x, y))
for x, y in columns:
    pts = [(x - 300, y - 300), (x + 300, y - 300), (x + 300, y + 300), (x - 300, y + 300)]
    msp.add_lwpolyline(pts, close=True, dxfattribs={"layer": "S-COLS"})
    h = msp.add_hatch(color=6, dxfattribs={"layer": "S-COLS"})
    h.paths.add_polyline_path(pts, is_closed=True)

# ---------------------------------------------------------------- furniture
def free(x0, y0, x1, y1, keep_out):
    return all(x1 < a or x0 > c or y1 < b or y0 > d for a, b, c, d in keep_out)

keep_out = [
    (0, 6000, 4300, 13200),          # stair 1 + approach
    (W - 4300, 6000, W, 13200),      # stair 2
    (CORE_X0 - 1500, 8500, CORE_X1 + 1500, CORE_Y1 + 1500),  # core + circulation ring
    (37700, 16700, W, H),            # boardroom
    (0, 17700, 6300, H),             # meeting NW
    (8000, 8500, 12000, 11000),      # door approach W
    (36000, 8500, 40200, 11000),     # door approach E
] + [(x - 700, y - 700, x + 700, y + 700) for x, y in columns]
desks = 0
for row_y in range(9300, 23000, 2800):
    for col_x in range(4600, 43800, 1700):
        for flip in (0, 1):
            y = row_y + (800 if flip else 0)
            if free(col_x - 50, y - (500 if flip else 450), col_x + 1650, y + 800 + (450 if not flip else 500), keep_out) and y + 1300 < H - 300:
                if flip:
                    msp.add_blockref("DESK_1600", (col_x + 1600, y + 800), dxfattribs={"layer": "A-FURN", "rotation": 180})
                else:
                    msp.add_blockref("DESK_1600", (col_x, y), dxfattribs={"layer": "A-FURN"})
                desks += 1
# boardroom table + meeting tables
msp.add_lwpolyline([(40000, 19300), (46000, 19300), (46000, 21700), (40000, 21700)], close=True, dxfattribs={"layer": "A-FURN"})
msp.add_lwpolyline([(1200, 20000), (4800, 20000), (4800, 22000), (1200, 22000)], close=True, dxfattribs={"layer": "A-FURN"})
msp.add_lwpolyline([(15200, 2000), (18800, 2000), (18800, 4400), (15200, 4400)], close=True, dxfattribs={"layer": "A-FURN"})
msp.add_lwpolyline([(29200, 2000), (32800, 2000), (32800, 4400), (29200, 4400)], close=True, dxfattribs={"layer": "A-FURN"})
msp.add_lwpolyline([(20600, 300), (27400, 300), (27400, 1000), (20600, 1000)], close=True, dxfattribs={"layer": "A-FURN"})  # pantry counter
for i in range(len(rooms_x) - 1):
    x0, x1 = rooms_x[i], rooms_x[i + 1]
    if room_names[i].startswith("OFFICE"):
        msp.add_lwpolyline([(x0 + 700, 1500), (x0 + 2500, 1500), (x0 + 2500, 2400), (x0 + 700, 2400)], close=True, dxfattribs={"layer": "A-FURN"})

# ---------------------------------------------------------------- labels
def label(text, x, y, h=300):
    msp.add_text(text, height=h, dxfattribs={"layer": "A-ANNO-TEXT"}).set_placement((x, y), align=TextEntityAlignment.MIDDLE_CENTER)
for i in range(len(rooms_x) - 1):
    label(room_names[i], (rooms_x[i] + rooms_x[i + 1]) / 2, 5200, 220)
label("CORRIDOR", 14000, 7500, 220)
label("CORRIDOR", 34000, 7500, 220)
label("OPEN PLAN OFFICE 310", 13000, 15700, 350)
label("OPEN PLAN OFFICE 311", 33000, 15700, 350)
label("BOARDROOM 312", 43000, 22900, 260)
label("MEETING 313", 3000, 22900, 220)
label("WC (M)", 20500, 9300, 200)
label("WC (F)", 23500, 9300, 200)

# dimensions
dim = msp.add_linear_dim(base=(0, -1600), p1=(0, 0), p2=(W, 0), dimstyle="EZDXF", dxfattribs={"layer": "A-ANNO-DIMS"})
dim.render()
dim = msp.add_linear_dim(base=(W + 1600, 0), p1=(W, 0), p2=(W, H), angle=90, dimstyle="EZDXF", dxfattribs={"layer": "A-ANNO-DIMS"})
dim.render()
dim = msp.add_linear_dim(base=(14000, 6500), p1=(14000, 6500), p2=(14000, 8500), angle=90, dimstyle="EZDXF", dxfattribs={"layer": "A-ANNO-DIMS"})
dim.render()

# title block + north arrow
tb = [(0, -9500), (W, -9500), (W, -4000), (0, -4000)]
msp.add_lwpolyline(tb, close=True, dxfattribs={"layer": "A-ANNO-TTLB"})
for t, y, h in (("SAMPLE TYPICAL OFFICE FLOOR - LEVEL 03 - GENERAL ARRANGEMENT PLAN", -5300, 600),
                ("FICTIONAL TEST DRAWING FOR EVACUATION SIMULATION - NOT A REAL PROJECT - UNITS: MILLIMETRES - SCALE 1:100 @ A1", -6600, 350),
                (f"GROSS FLOOR AREA {W*H/1e6:.0f} m2  |  WORKSTATIONS {desks}  |  ESCAPE: STAIR 1 (WEST) + STAIR 2 (EAST), FD60S FIRE DOORS 1000 mm", -7600, 350),
                ("LAYERS: A-WALL-*, A-GLAZ, A-DOOR, A-DOOR-FIRE, A-STAIR, F-EXIT, S-COLS, A-FURN, A-ANNO-*", -8600, 300)):
    msp.add_text(t, height=h, dxfattribs={"layer": "A-ANNO-TTLB"}).set_placement((600, y), align=TextEntityAlignment.MIDDLE_LEFT)
nx, ny = W + 4000, H - 1500
msp.add_circle((nx, ny), 1000, dxfattribs={"layer": "A-ANNO-TTLB"})
msp.add_lwpolyline([(nx, ny + 1000), (nx + 450, ny - 700), (nx, ny - 300), (nx - 450, ny - 700)], close=True, dxfattribs={"layer": "A-ANNO-TTLB"})
msp.add_text("N", height=500, dxfattribs={"layer": "A-ANNO-TTLB"}).set_placement((nx, ny + 1500), align=TextEntityAlignment.MIDDLE_CENTER)

out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "Sample_Office_Level03.dxf")

doc.saveas(out)
print("saved", out, "desks:", desks)
