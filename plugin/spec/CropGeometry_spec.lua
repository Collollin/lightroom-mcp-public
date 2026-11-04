local CropGeometry = require 'CropGeometry'
local ImageFrame = require 'ImageFrame'

local bounds = { left = 0.1, top = 0.2, right = 0.8, bottom = 0.7 }
local function closeBounds(expected, actual)
    assert.is_true(CropGeometry.matches(expected, actual))
end

describe("CropGeometry", function()
    local expected = {
        AB = { 0.1, 0.2, 0.8, 0.7 }, BA = { 0.2, 0.2, 0.9, 0.7 },
        CD = { 0.2, 0.3, 0.9, 0.8 }, DC = { 0.1, 0.3, 0.8, 0.8 },
        CB = { 0.2, 0.1, 0.7, 0.8 }, BC = { 0.2, 0.2, 0.7, 0.9 },
        AD = { 0.3, 0.2, 0.8, 0.9 }, DA = { 0.3, 0.1, 0.8, 0.8 },
    }
    for orientation, edges in pairs(expected) do
        it("maps asymmetric displayed bounds to independently listed " .. orientation .. " edges", function()
            local actual = CropGeometry.transform(bounds, ImageFrame.fromOrientation(orientation).toStored)
            closeBounds({ left = edges[1], top = edges[2], right = edges[3], bottom = edges[4] }, actual)
            closeBounds(bounds, CropGeometry.transform(actual, ImageFrame.fromOrientation(orientation).toDisplayed))
        end)
    end

    it("fits physical 4:5 pixels in a portrait and aligns the vertical slack", function()
        local request = CropGeometry.parse({ crop = { kind = "aspect", width = 4, height = 5,
            anchor = { x = 1, y = 1 } } })
        closeBounds({ left = 0, top = 0.25, right = 1, bottom = 1 },
            CropGeometry.plan(request, { width = 600, height = 1000 }))
    end)

    it("fits a landscape ratio and defaults to centered slack", function()
        local request = CropGeometry.parse({ crop = { kind = "aspect", width = 2, height = 1 } })
        closeBounds({ left = 0, top = 1 / 12, right = 1, bottom = 11 / 12 },
            CropGeometry.plan(request, { width = 1000, height = 600 }))
    end)

    it("accepts exactly one displayed pixel on each axis", function()
        closeBounds({ left = 0, top = 0, right = 0.001, bottom = 0.002 }, CropGeometry.plan(
            { kind = "bounds", left = 0, top = 0, right = 0.001, bottom = 0.002 },
            { width = 1000, height = 500 }))
    end)

    it("accepts one-pixel spans after anchored floating-point subtraction", function()
        for _, crop in ipairs({
            { kind = "bounds", left = 0.01, top = 0, right = 0.011, bottom = 1 },
            { kind = "aspect", width = 1, height = 600 },
        }) do
            local actual = CropGeometry.plan(CropGeometry.parse({ crop = crop }), { width = 1000, height = 600 })
            assert.is_true(math.abs((actual.right - actual.left) * 1000 - 1) < 1e-9)
        end
        assert.has_error(function()
            CropGeometry.plan({ kind = "bounds", left = 0.01, top = 0, right = 0.010999999, bottom = 1 },
                { width = 1000, height = 600 })
        end)
    end)

    it("rejects invalid, mixed and unrepresentable inputs", function()
        for _, crop in ipairs({
            {}, { kind = "bounds", left = 0.8, right = 0.1, top = 0, bottom = 1 },
            { kind = "bounds", left = 0, right = 1, top = 0 / 0, bottom = 1 },
            { kind = "bounds", left = 0, right = 1, top = 0, bottom = 1, width = 4 },
            { kind = "aspect", width = 0, height = 1 }, { kind = "aspect", width = math.huge, height = 1 },
            { kind = "aspect", width = 1e308, height = 1e-308 },
            { kind = "aspect", width = 1e-308, height = 1e308 },
            { kind = "aspect", width = 4, height = 5, anchor = { x = 0 } },
            { kind = "aspect", width = 4, height = 5, anchor = false },
            { kind = "aspect", width = 4, height = 5, within = "current" },
        }) do
            assert.has_error(function() CropGeometry.parse({ crop = crop }) end)
        end
        assert.has_error(function() CropGeometry.parse({ crop = { kind = "aspect", width = 1, height = 1 }, extra = 1 }) end)
    end)

    it("refuses extreme aspect ratios and subpixel or collapsed spans", function()
        for _, crop in ipairs({
            { kind = "aspect", width = 1e-100, height = 1, anchor = { x = 1, y = 1 } },
            { kind = "aspect", width = 1e100, height = 1 },
            { kind = "bounds", left = 0, top = 0, right = 0.0001, bottom = 1 },
        }) do
            local request = CropGeometry.parse({ crop = crop })
            assert.has_error(function() CropGeometry.plan(request, { width = 1000, height = 600 }) end)
        end
    end)
end)
