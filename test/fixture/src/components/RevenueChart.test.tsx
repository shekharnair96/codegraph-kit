import { buildSeries } from "@/utils/series";
import { PRIMARY_SERIES_COLOR } from "@/config/colors";

jest.mock("@/utils/series", () => ({
  ...jest.requireActual("@/utils/series"),
  nextSeriesId: () => 42,
}));

describe("buildSeries", () => {
  it("uses the primary color for revenue", () => {
    expect(buildSeries("revenue").color).toBe("#07A093");
    expect(buildSeries("revenue").color).toBe(PRIMARY_SERIES_COLOR);
    expect(buildSeries("revenue").strokeWidth).toBe(1);
  });
});
