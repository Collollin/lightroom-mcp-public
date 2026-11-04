local helper = require 'spec_helper'

local function setup(opts)
    opts = opts or {}
    local settings = {
        CropLeft = 0, CropTop = 0, CropRight = 1, CropBottom = 1, CropAngle = 0,
        PerspectiveScale = 100, PerspectiveUpright = 0, LensProfileEnable = 0,
        PerspectiveRotate = 0, PerspectiveAspect = 0, PerspectiveHorizontal = 0, PerspectiveVertical = 0,
        PerspectiveX = 0, PerspectiveY = 0, LensManualDistortionAmount = 0,
        Exposure2012 = 0.7, MaskGroupBasedCorrections = { { CorrectionID = "mask-1" } },
    }
    for key, value in pairs(opts.settings or {}) do settings[key] = value end
    if opts.noEdges then
        settings.CropLeft, settings.CropTop, settings.CropRight, settings.CropBottom = nil, nil, nil, nil
    end
    if opts.missingGeometry then settings[opts.missingGeometry] = nil end
    local meta = {
        id = "1", orientation = opts.orientation or "AB", dimensions = opts.dimensions or { width = 1000, height = 600 },
        croppedDimensions = { width = 1000, height = 600 }, developSettings = settings,
    }
    local photo = helper.fakePhoto(meta)
    local calls = { writes = 0, views = 0, sleeps = 0, observations = 0 }
    local catalog = helper.fakeCatalog({ photos = { photo } })
    local write = catalog.withWriteAccessDo
    catalog.withWriteAccessDo = function(self, label, fn)
        if opts.beforeWrite then opts.beforeWrite(meta) end
        return write(self, label, fn)
    end
    photo.applyDevelopSettings = function(_, patch)
        calls.writes, calls.patch = calls.writes + 1, patch
        if opts.writeError then error("write interrupted") end
        for key, value in pairs(patch) do
            settings[key] = opts.roundCrop and math.floor(value * 1e6 + 0.5) / 1e6 or value
        end
        if not opts.stale then
            local swapped = meta.orientation == "BC"
            meta.croppedDimensions = {
                width = math.floor(meta.dimensions.width * (swapped and (settings.CropBottom - settings.CropTop)
                    or (settings.CropRight - settings.CropLeft)) + 0.5),
                height = math.floor(meta.dimensions.height * (swapped and (settings.CropRight - settings.CropLeft)
                    or (settings.CropBottom - settings.CropTop)) + 0.5),
            }
        end
        if opts.afterWrite then opts.afterWrite(meta) end
    end
    photo.getDevelopSettings = function()
        calls.observations = calls.observations + 1
        if opts.readError and calls.writes > 0 then error("settings unreadable") end
        return settings
    end
    helper.installImport({
        LrApplication = { activeCatalog = function() return catalog end },
        LrApplicationView = { getCurrentModuleName = function() calls.views = calls.views + 1; return "develop" end },
        LrDevelopController = {}, LrSelection = {},
        LrTasks = { pcall = pcall, sleep = function() calls.sleeps = calls.sleeps + 1
            if opts.onSleep then opts.onSleep(meta, calls) end
        end },
        LrLogger = helper.defaultLrLogger(),
    })
    for _, name in ipairs({ "HandlerCrop", "DevelopSession", "Log" }) do package.loaded[name] = nil end
    return require 'HandlerCrop', calls, meta, catalog
end

local function request(crop)
    return { photo_id = "1", crop = crop or { kind = "bounds", left = 0.1, top = 0.2, right = 0.8, bottom = 0.7 } }
end

describe("set_photo_crop", function()
    it("writes only four edges and returns observed displayed crop and dimensions without any view access", function()
        local handler, calls, meta, catalog = setup({ orientation = "BC", dimensions = { width = 600, height = 1000 } })
        local result = handler.setPhotoCrop(request())
        assert.is_true(result.success)
        assert.is_true(result.changed)
        assert.are.equal("settings_and_metadata", result.verification)
        assert.are.equal("full_uncropped_displayed_normalized", result.coordinate_space)
        assert.are.same({ width = 420, height = 500 }, result.cropped_dimensions)
        assert.is_true(math.abs(result.bounds.left - 0.1) < 1e-7)
        for key, expected in pairs({ CropLeft = 0.2, CropTop = 0.2, CropRight = 0.7, CropBottom = 0.9 }) do
            assert.is_true(math.abs(calls.patch[key] - expected) < 1e-7)
        end
        local count = 0
        for _ in pairs(calls.patch) do count = count + 1 end
        assert.are.equal(4, count)
        assert.are.equal(0.7, meta.developSettings.Exposure2012)
        assert.are.same({ { CorrectionID = "mask-1" } }, meta.developSettings.MaskGroupBasedCorrections)
        assert.are.equal(0, calls.views)
        assert.is_false(catalog:getQueriedInsideReadAccess())
    end)

    it("replaces an existing crop and avoids another history write for the same request", function()
        local handler, calls = setup({ settings = { CropLeft = 0.3, CropRight = 0.6 } })
        assert.is_true(handler.setPhotoCrop(request()).changed)
        assert.is_false(handler.setPhotoCrop(request()).changed)
        assert.are.equal(1, calls.writes)
    end)

    it("verifies Lightroom's six-decimal crop readback without another history write", function()
        local handler, calls = setup({ roundCrop = true })
        local args = request({ kind = "aspect", width = 2, height = 1, anchor = { x = 1, y = 0 } })
        local result = handler.setPhotoCrop(args)
        assert.is_true(result.success)
        assert.are.equal(0.833333, result.bounds.bottom)
        assert.are.same({ width = 1000, height = 500 }, result.cropped_dimensions)
        assert.is_false(handler.setPhotoCrop(args).changed)
        assert.are.equal(1, calls.writes)
    end)

    it("recognizes a missing crop as the full frame", function()
        local handler, calls = setup({ noEdges = true })
        local result = handler.setPhotoCrop(request({ kind = "bounds", left = 0, top = 0, right = 1, bottom = 1 }))
        assert.is_false(result.changed)
        assert.are.equal(0, calls.writes)
    end)

    it("rejects unsupported states and malformed requests before writing", function()
        for _, settings in ipairs({ { CropAngle = 2 }, { PerspectiveScale = 99 }, { PerspectiveUpright = 1 },
            { LensManualDistortionAmount = 1 }, { LensProfileEnable = 1 }, { CropAngle = "0" } }) do
            local handler, calls = setup({ settings = settings })
            assert.has_error(function() handler.setPhotoCrop(request()) end)
            assert.are.equal(0, calls.writes)
        end
        local handler, calls = setup({ orientation = "unknown" })
        assert.has_error(function() handler.setPhotoCrop(request()) end)
        assert.are.equal(0, calls.writes)
        handler, calls = setup()
        assert.has_error(function() handler.setPhotoCrop(request({ kind = "aspect", width = 1e308, height = 1e-308 })) end)
        assert.are.equal(0, calls.writes)
    end)

    it("refuses a geometry conflict inside the write gate", function()
        local handler, calls = setup({ beforeWrite = function(meta) meta.developSettings.CropAngle = 1 end })
        assert.has_error(function() handler.setPhotoCrop(request()) end)
        assert.are.equal(0, calls.writes)
    end)

    it("refuses missing geometric controls and unknown perspective fields before writing", function()
        for _, key in ipairs({ "CropAngle", "PerspectiveUpright", "PerspectiveScale", "LensProfileEnable" }) do
            local handler, calls = setup({ missingGeometry = key })
            assert.has_error(function() handler.setPhotoCrop(request()) end)
            assert.are.equal(0, calls.writes)
        end
        local handler, calls = setup({ settings = { PerspectiveFutureWarp = 1 } })
        assert.has_error(function() handler.setPhotoCrop(request()) end)
        assert.are.equal(0, calls.writes)
    end)

    it("never calls stale metadata verified and includes its actual observation", function()
        local handler, calls = setup({ stale = true })
        local result = handler.setPhotoCrop(request())
        assert.is_false(result.success)
        assert.is_true(result.write_attempted)
        assert.are.equal("unverified", result.verification)
        assert.are.same({ width = 1000, height = 600 }, result.observation.cropped_dimensions)
        assert.are.equal(1, calls.writes)
        assert.is_true(calls.sleeps > 0)
    end)

    it("waits for both dimensions to catch up", function()
        local handler = setup({ stale = true, onSleep = function(meta, calls)
            if calls.sleeps == 2 then meta.croppedDimensions = { width = 700, height = 300 } end
        end })
        assert.is_true(handler.setPhotoCrop(request()).success)
    end)

    it("detects geometry changes during polling without undoing them", function()
        for _, mutate in ipairs({
            function(meta) meta.orientation = "BA" end,
            function(meta) meta.developSettings.PerspectiveHorizontal = 2 end,
        }) do
            local handler, calls = setup({ stale = true, onSleep = mutate })
            local result = handler.setPhotoCrop(request())
            assert.is_false(result.success)
            assert.is_truthy(result.error:find("geometry changed", 1, true))
            assert.are.equal(1, calls.writes)
        end
    end)

    it("reports write exceptions as uncertain and read exceptions without a fabricated observation", function()
        local handler = setup({ writeError = true })
        local result = handler.setPhotoCrop(request())
        assert.is_false(result.success)
        assert.is_true(result.write_attempted)
        assert.are.equal(0, result.observation.bounds.left)
        handler = setup({ readError = true })
        result = handler.setPhotoCrop(request())
        assert.is_false(result.success)
        assert.is_nil(result.observation)
        assert.is_truthy(result.observation_error:find("unreadable", 1, true))
    end)
end)
