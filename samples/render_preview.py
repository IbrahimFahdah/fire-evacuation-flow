import os
HERE = os.path.dirname(os.path.abspath(__file__))
import ezdxf, matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from ezdxf.addons.drawing import RenderContext, Frontend
from ezdxf.addons.drawing.matplotlib import MatplotlibBackend
from ezdxf.addons.drawing.config import Configuration, BackgroundPolicy, ColorPolicy

doc = ezdxf.readfile(os.path.join(HERE, "Sample_Office_Level03.dxf"))
fig = plt.figure(figsize=(20, 13), dpi=130)
ax = fig.add_axes([0, 0, 1, 1])
cfg = Configuration(background_policy=BackgroundPolicy.WHITE, color_policy=ColorPolicy.COLOR)
Frontend(RenderContext(doc), MatplotlibBackend(ax), config=cfg).draw_layout(doc.modelspace())
fig.savefig(os.path.join(HERE, "Sample_Office_Level03_preview.png"), facecolor="white")
