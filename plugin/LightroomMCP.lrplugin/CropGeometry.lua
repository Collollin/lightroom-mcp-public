local CropGeometry = {}

function CropGeometry.finite(value)
    return type(value) == "number" and value == value and math.abs(value) < math.huge
end

local function unit(value, name)
    if not CropGeometry.finite(value) or value < 0 or value > 1 then
        error(name .. " must be a finite number from 0 to 1", 0)
    end
    return value
end

local function onlyKeys(value, allowed, name)
    if type(value) ~= "table" then error(name .. " must be an object", 0) end
    for key in pairs(value) do
        if not allowed[key] then error(name .. " has an unknown field " .. tostring(key), 0) end
    end
end

function CropGeometry.bounds(value)
    local bounds = {}
    for _, key in ipairs({ "left", "top", "right", "bottom" }) do
        bounds[key] = unit(value[key], key)
    end
    if bounds.left >= bounds.right or bounds.top >= bounds.bottom then
        error("Crop bounds must have left < right and top < bottom", 0)
    end
    return bounds
end

function CropGeometry.parse(args)
    onlyKeys(args, { photo_id = true, crop = true }, "arguments")
    local crop = args.crop
    if type(crop) ~= "table" then error("crop must be an object", 0) end
    if crop.kind == "bounds" then
        onlyKeys(crop, { kind = true, left = true, top = true, right = true, bottom = true }, "crop")
        local bounds = CropGeometry.bounds(crop)
        bounds.kind = "bounds"
        return bounds
    end
    if crop.kind ~= "aspect" then error("crop.kind must be bounds or aspect", 0) end
    onlyKeys(crop, { kind = true, width = true, height = true, anchor = true }, "crop")
    for _, key in ipairs({ "width", "height" }) do
        if not CropGeometry.finite(crop[key]) or crop[key] <= 0 then
            error("crop." .. key .. " must be finite and positive", 0)
        end
    end
    local ratio = crop.width / crop.height
    if not CropGeometry.finite(ratio) or ratio <= 0 then error("Crop ratio is not representable", 0) end
    local anchor = crop.anchor
    if anchor == nil then anchor = { x = 0.5, y = 0.5 } end
    onlyKeys(anchor, { x = true, y = true }, "anchor")
    return { kind = "aspect", ratio = ratio, x = unit(anchor.x, "anchor.x"), y = unit(anchor.y, "anchor.y") }
end

function CropGeometry.dimensions(value)
    if type(value) ~= "table" then error("Photo dimensions are unavailable", 0) end
    for _, key in ipairs({ "width", "height" }) do
        if not CropGeometry.finite(value[key]) or value[key] <= 0 then
            error("Photo dimensions must be finite and positive", 0)
        end
    end
    return { width = value.width, height = value.height }
end

function CropGeometry.plan(request, dimensions)
    local bounds
    if request.kind == "bounds" then
        bounds = CropGeometry.bounds(request)
    else
        local width, height = 1, 1
        local imageRatio = dimensions.width / dimensions.height
        if request.ratio < imageRatio then width = request.ratio / imageRatio
        else height = imageRatio / request.ratio end
        local left, top = (1 - width) * request.x, (1 - height) * request.y
        bounds = CropGeometry.bounds({ left = left, top = top, right = left + width, bottom = top + height })
    end
    if (bounds.right - bounds.left) * dimensions.width < 1 - 1e-9
        or (bounds.bottom - bounds.top) * dimensions.height < 1 - 1e-9 then
        error("Crop must retain at least one pixel on each displayed axis", 0)
    end
    return bounds
end

function CropGeometry.transform(bounds, transform)
    local left, top, right, bottom = 1, 1, 0, 0
    for _, corner in ipairs({ { bounds.left, bounds.top }, { bounds.right, bounds.top },
        { bounds.left, bounds.bottom }, { bounds.right, bounds.bottom } }) do
        local x, y = transform(corner[1], corner[2])
        left, top, right, bottom = math.min(left, x), math.min(top, y), math.max(right, x), math.max(bottom, y)
    end
    return { left = left, top = top, right = right, bottom = bottom }
end

function CropGeometry.matches(a, b)
    for _, key in ipairs({ "left", "top", "right", "bottom" }) do
        if math.abs(a[key] - b[key]) > 1e-6 then return false end
    end
    return true
end

return CropGeometry
