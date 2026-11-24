import Foundation
import CoreGraphics

public enum FloatingPanelGeometry {
    /// Keep the original top-left anchor where possible, but never grow below
    /// the visible desktop or leave controls beyond a display edge.
    public static func frame(current: CGRect, desired: CGSize, visible: CGRect) -> CGRect {
        let width = min(desired.width, visible.width), height = min(desired.height, visible.height)
        return CGRect(x: max(visible.minX, min(current.minX, visible.maxX - width)),
                      y: max(visible.minY, min(current.maxY - height, visible.maxY - height)),
                      width: width, height: height)
    }
}
