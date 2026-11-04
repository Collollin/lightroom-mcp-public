local LrApplication = import 'LrApplication'
local LrTasks = import 'LrTasks'

local CropGeometry = require 'CropGeometry'
local DevelopSession = require 'DevelopSession'
local ImageFrame = require 'ImageFrame'
local PhotoLookup = require 'PhotoLookup'

local HandlerCrop = {}

local EDGES = { left = "CropLeft", top = "CropTop", right = "CropRight", bottom = "CropBottom" }
local NEUTRAL = {
    CropAngle = 0, PerspectiveRotate = 0, PerspectiveUpright = 0, PerspectiveAspect = 0,
    PerspectiveHorizontal = 0, PerspectiveVertical = 0, PerspectiveScale = 100,
    PerspectiveX = 0, PerspectiveY = 0, LensManualDistortionAmount = 0, LensProfileEnable = 0,
}

local function equal(a, b)
    if type(a) ~= type(b) then return false end
    if type(a) ~= "table" then return a == b end
    for key, value in pairs(a) do if not equal(value, b[key]) then return false end end
    for key in pairs(b) do if a[key] == nil then return false end end
    return true
end

local function observe(photo)
    local settings = photo:getDevelopSettings()
    if type(settings) ~= "table" then error("Develop settings are unavailable", 0) end
    local bounds, count = {}, 0
    for key, sdkKey in pairs(EDGES) do
        if settings[sdkKey] ~= nil then count = count + 1 end
        bounds[key] = settings[sdkKey]
    end
    if count == 0 then bounds = { left = 0, top = 0, right = 1, bottom = 1 }
    elseif count ~= 4 then error("Photo crop bounds are incomplete", 0) end
    bounds = CropGeometry.bounds(bounds)
    local fingerprint = {}
    for key, value in pairs(settings) do
        if (key:match("^Crop") or key:match("^Perspective") or key:match("^Lens"))
            and key ~= "CropLeft" and key ~= "CropTop" and key ~= "CropRight" and key ~= "CropBottom" then
            fingerprint[key] = value
        end
    end
    local dimensions = CropGeometry.dimensions(photo:getRawMetadata("dimensions"))
    local orientation = photo:getRawMetadata("orientation")
    fingerprint.orientation, fingerprint.dimensions = orientation, dimensions
    return {
        bounds = bounds, settings = settings, fingerprint = fingerprint, orientation = orientation,
        dimensions = dimensions, cropped = photo:getRawMetadata("croppedDimensions"),
    }
end

local function requireSupported(observation)
    for key in pairs(observation.settings) do
        if key:match("^Perspective") and NEUTRAL[key] == nil then
            error("set_photo_crop cannot map " .. key .. "; nothing was written", 0)
        end
    end
    for key, neutral in pairs(NEUTRAL) do
        local value = observation.settings[key]
        if value == nil then
            error("set_photo_crop needs readable " .. key .. "; nothing was written", 0)
        end
        if value ~= neutral then
            error("set_photo_crop cannot map active " .. key .. "; nothing was written", 0)
        end
    end
end

local function read(catalog, photo)
    local observation
    catalog:withReadAccessDo(function() observation = observe(photo) end)
    return observation
end

local function resultFor(photoId, previous, actual, changed)
    local frame = ImageFrame.fromOrientation(actual.orientation)
    return {
        success = true, photo_id = photoId, changed = changed,
        coordinate_space = "full_uncropped_displayed_normalized",
        orientation = actual.orientation,
        previous_bounds = CropGeometry.transform(previous.bounds, ImageFrame.fromOrientation(previous.orientation).toDisplayed),
        bounds = CropGeometry.transform(actual.bounds, frame.toDisplayed),
        uncropped_dimensions = actual.dimensions, cropped_dimensions = actual.cropped,
        dimension_source = "photo.getRawMetadata", verification = "settings_and_metadata",
    }
end

local function dimensionsMatch(actual, bounds, dimensions)
    if type(actual) ~= "table" then return false end
    local width = (bounds.right - bounds.left) * dimensions.width
    local height = (bounds.bottom - bounds.top) * dimensions.height
    return CropGeometry.finite(actual.width) and CropGeometry.finite(actual.height)
        and actual.width > 0 and actual.height > 0
        and math.abs(actual.width - width) <= 1 and math.abs(actual.height - height) <= 1
end

function HandlerCrop.setPhotoCrop(args)
    local request = CropGeometry.parse(args)
    local photoId = args.photo_id
    if not ((type(photoId) == "string" and photoId ~= "") or CropGeometry.finite(photoId)) then
        error("photo_id is required", 0)
    end
    photoId = tostring(photoId)
    local catalog = LrApplication.activeCatalog()
    local photo = PhotoLookup.resolveOne(catalog, photoId)
    if not photo then error("Photo not found: " .. photoId, 0) end

    return DevelopSession.run("set_photo_crop", catalog, false, function()
        local previous = read(catalog, photo)
        requireSupported(previous)
        local frame = ImageFrame.fromOrientation(previous.orientation)
        local displayed = CropGeometry.plan(request, previous.dimensions)
        local stored = CropGeometry.transform(displayed, frame.toStored)
        local changed = not CropGeometry.matches(previous.bounds, stored)
        local attempted, actual = false, previous
        local ok, problem = LrTasks.pcall(function()
            if changed then
                catalog:withWriteAccessDo("Set displayed photo crop", function()
                    actual = observe(photo)
                    if not equal(actual.fingerprint, previous.fingerprint)
                        or not equal(actual.bounds, previous.bounds) then
                        error("Photo geometry changed before the crop write; nothing was written", 0)
                    end
                    local patch = {}
                    for key, sdkKey in pairs(EDGES) do patch[sdkKey] = stored[key] end
                    attempted = true
                    photo:applyDevelopSettings(patch)
                end)
            end
            local matched = DevelopSession.waitFor(function()
                actual = read(catalog, photo)
                if not equal(actual.fingerprint, previous.fingerprint) then
                    error("Photo geometry changed while verifying the crop", 0)
                end
                return CropGeometry.matches(actual.bounds, stored)
                    and dimensionsMatch(actual.cropped, displayed, previous.dimensions)
            end, 5)
            if not matched then error("Crop settings or cropped dimensions did not confirm the requested crop", 0) end
        end)
        if not ok then
            if not attempted then error(tostring(problem) .. "; crop write was not attempted", 0) end
            local observed, latest = LrTasks.pcall(read, catalog, photo)
            local outcome = {
                success = false, photo_id = photoId, write_attempted = true,
                verification = "unverified", error = tostring(problem),
            }
            if observed then
                local mapped, observation = LrTasks.pcall(resultFor, photoId, previous, latest, changed)
                if mapped then
                    observation.success, observation.verification = nil, nil
                    outcome.observation = observation
                else
                    outcome.observation = { orientation = latest.orientation, stored_bounds = latest.bounds,
                        uncropped_dimensions = latest.dimensions, cropped_dimensions = latest.cropped }
                end
            else outcome.observation_error = tostring(latest) end
            return outcome
        end
        return resultFor(photoId, previous, actual, changed)
    end)
end

return HandlerCrop
