local LrApplication = import 'LrApplication'
local LrSelection = import 'LrSelection'
local LrTasks = import 'LrTasks'

local DevelopSession = require 'DevelopSession'
local JSON = require 'JSON'
local PhotoLookup = require 'PhotoLookup'

local Handler = {}
local STATES = { pending = true, attempting = true, recorded = true, uncertain = true }
local blockedResultsByCatalog = {}

local function nonempty(value)
    return type(value) == 'string' and value:find('%S') ~= nil
end

local function normalize(args)
    args = args or {}
    if type(args.photo_ids) ~= 'table' or #args.photo_ids == 0 or #args.photo_ids > 25 then
        error('photo_ids must contain 1 to 25 photo IDs or paths')
    end
    local ids = {}
    for i, id in ipairs(args.photo_ids) do
        if not nonempty(id) and type(id) ~= 'number' then
            error('photo_ids must contain photo IDs or paths')
        end
        if type(id) == 'number' and (id ~= id or id == math.huge or id == -math.huge) then
            error('photo_ids must contain finite photo IDs or paths')
        end
        ids[i] = tostring(id)
    end
    if args.copy_name ~= nil and not nonempty(args.copy_name) then
        error('copy_name must be a non-empty string')
    end
    if args.operation_id ~= nil and (not nonempty(args.operation_id) or #args.operation_id > 128) then
        error('operation_id must be a nonblank string of at most 128 UTF-8 bytes')
    end
    return { photo_ids = ids, copy_name = args.copy_name }, args.operation_id
end

local function sameRequest(a, b)
    if a.copy_name ~= b.copy_name or #a.photo_ids ~= #b.photo_ids then return false end
    for i, id in ipairs(a.photo_ids) do
        if id ~= b.photo_ids[i] then return false end
    end
    return true
end

local function propertyKey(id)
    return 'vcOperation.v1.' .. (id:gsub('.', function(byte) return string.format('%02x', byte:byte()) end))
end

local function problem(code, message, source)
    return { code = code, message = tostring(message), photo_id = source and source.photo_id }
end

local function array(value)
    if type(value) ~= 'table' then return false end
    local count = 0
    for key in pairs(value) do
        if type(key) ~= 'number' or key < 1 or key ~= math.floor(key) then return false end
        count = count + 1
    end
    return count == #value
end

local function validRecord(record)
    if type(record) ~= 'table' or record.version ~= 1 or type(record.request) ~= 'table'
        or not array(record.request.photo_ids) or #record.request.photo_ids == 0
        or #record.request.photo_ids > 25 or not array(record.inputs) or not array(record.sources)
        or #record.inputs ~= #record.request.photo_ids or #record.sources > #record.inputs then return false end
    if record.request.copy_name ~= nil and not nonempty(record.request.copy_name) then return false end
    local seen = {}
    for _, source in ipairs(record.sources) do
        if type(source) ~= 'table' or not STATES[source.state] or not nonempty(source.photo_id)
            or not nonempty(source.photo_uuid) or not nonempty(source.master_id)
            or not nonempty(source.master_uuid) or seen[source.photo_id]
            or not array(source.copies) or not array(source.observed) then return false end
        seen[source.photo_id] = true
        if (source.state == 'pending' or source.state == 'attempting')
            and (#source.copies > 0 or #source.observed > 0) then return false end
        if source.state == 'recorded' and #source.copies ~= 1 then return false end
        for _, copy in ipairs(source.copies) do
            if type(copy) ~= 'table' or copy.photo_id ~= source.photo_id
                or copy.master_id ~= source.master_id or not nonempty(copy.copy_id) then return false end
        end
        for _, copy in ipairs(source.observed) do
            if type(copy) ~= 'table' or copy.photo_id ~= source.photo_id
                or copy.expected_master_id ~= source.master_id or not nonempty(copy.copy_id)
                or type(copy.verified) ~= 'boolean' then return false end
        end
        if source.state == 'uncertain' and (type(source.failure) ~= 'table'
            or not nonempty(source.failure.code) or not nonempty(source.failure.message)) then return false end
    end
    local referenced = {}
    for i, input in ipairs(record.inputs) do
        if not nonempty(record.request.photo_ids[i]) or type(input) ~= 'table'
            or input.input_id ~= record.request.photo_ids[i] then return false end
        local index = input.source_index
        if index ~= nil then
            if type(index) ~= 'number' or index ~= math.floor(index) or not record.sources[index] then return false end
            referenced[index] = true
        end
    end
    for i in ipairs(record.sources) do if not referenced[i] then return false end end
    return true
end

local function load(catalog, key)
    local raw = catalog:getPropertyForPlugin(_PLUGIN, key)
    if raw == nil then return nil, nil end
    if type(raw) ~= 'string' then error('Invalid virtual-copy operation record') end
    local record = JSON:decode(raw, true)
    if not validRecord(record) then error('Invalid or unsupported virtual-copy operation record') end
    return record, raw
end

local function checkpoint(context)
    if not context.key then return true end
    local raw = JSON:encode(context.record)
    local ok, failure = LrTasks.pcall(function()
        context.catalog:withPrivateWriteAccessDo(function()
            if context.catalog:getPropertyForPlugin(_PLUGIN, context.key) ~= context.raw then
                error('Virtual-copy operation changed in another runtime')
            end
            context.catalog:setPropertyForPlugin(_PLUGIN, context.key, raw)
        end, { timeout = 10 })
        if context.catalog:getPropertyForPlugin(_PLUGIN, context.key) ~= raw then
            error('Virtual-copy operation checkpoint did not commit')
        end
    end)
    if ok then
        context.raw = raw
        return true
    end
    context.failure = problem('checkpoint_failed', failure)
    blockedResultsByCatalog[context.catalogPath] = blockedResultsByCatalog[context.catalogPath] or {}
    blockedResultsByCatalog[context.catalogPath][context.key] = { record = context.record, failure = context.failure }
    return false
end

local function plan(catalog, request)
    local record = { version = 1, request = request, inputs = {}, sources = {} }
    local byId = {}
    for i, entry in ipairs(PhotoLookup.resolveMany(catalog, request.photo_ids)) do
        local input = { input_id = request.photo_ids[i] }
        record.inputs[i] = input
        if entry.photo then
            local photo = entry.photo
            local id = tostring(photo.localIdentifier)
            if not byId[id] then
                local master = photo:getRawMetadata('masterPhoto') or photo
                local source = { state = 'pending', photo_id = id, photo_uuid = photo:getRawMetadata('uuid'),
                    master_id = tostring(master.localIdentifier), master_uuid = master:getRawMetadata('uuid'),
                    copies = {}, observed = {} }
                if not nonempty(source.photo_uuid) or not nonempty(source.master_uuid) then
                    error('Could not identify source and master for photo ' .. id)
                end
                record.sources[#record.sources + 1] = source
                byId[id] = #record.sources
            end
            input.source_index = byId[id]
        end
    end
    return record
end

local function snapshot(record, operationId, failure, restoreFailure, forcedStatus)
    local result = { operation_id = operationId, created = 0, copies = {}, missing = {}, inputs = {},
        observed_copies = {}, retryable = false, failure = failure, restoration_error = restoreFailure }
    local pending, uncertain = false, false
    for _, source in ipairs(record and record.sources or {}) do
        pending = pending or source.state == 'pending'
        uncertain = uncertain or source.state == 'attempting' or source.state == 'uncertain'
        for _, copy in ipairs(source.copies) do result.copies[#result.copies + 1] = copy end
        for _, copy in ipairs(source.observed) do result.observed_copies[#result.observed_copies + 1] = copy end
        if not result.failure and source.state == 'attempting' then
            result.failure = problem('creation_uncertain', 'A previous creation attempt has no recorded outcome', source)
        elseif not result.failure and source.state == 'uncertain' then
            result.failure = source.failure
        end
    end
    for i, binding in ipairs(record and record.inputs or {}) do
        local source = binding.source_index and record.sources[binding.source_index]
        local input = { index = i, input_id = binding.input_id, status = source and source.state or 'missing',
            photo_id = source and source.photo_id, master_id = source and source.master_id, copy_ids = {} }
        if source then
            for _, observed in ipairs(source.observed) do input.copy_ids[#input.copy_ids + 1] = observed.copy_id end
        else
            result.missing[#result.missing + 1] = binding.input_id
        end
        result.inputs[#result.inputs + 1] = input
    end
    result.created = #result.copies
    result.status = forcedStatus or (uncertain and 'uncertain' or (pending and 'partial' or 'complete'))
    result.retryable = operationId ~= nil and not forcedStatus and pending and not uncertain
        and (not failure or failure.code == 'selection_failed')
    return result
end

local function samePhotos(actual, expected)
    if #actual ~= #expected then return false end
    local wanted = {}
    for _, photo in ipairs(expected) do wanted[photo] = true end
    for _, photo in ipairs(actual) do if not wanted[photo] then return false end end
    return true
end

local function select(catalog, active, photos)
    local sinceAction, quietChecks = 1, 0
    return DevelopSession.waitFor(function()
        if sinceAction >= 1 then
            if active then catalog:setSelectedPhotos(active, photos) else LrSelection.selectNone() end
            sinceAction = 0
        end
        sinceAction = sinceAction + 0.1
        if not active then
            quietChecks = catalog:getTargetPhoto() == nil and quietChecks + 1 or 0
            return quietChecks >= 11
        end
        return catalog:getTargetPhoto() == active and samePhotos(catalog:getTargetPhotos() or {}, photos)
    end, 10)
end

local function frozenPhoto(catalog, source)
    local photo = PhotoLookup.resolveOne(catalog, source.photo_id)
    if not photo or photo:getRawMetadata('uuid') ~= source.photo_uuid then
        error('Frozen source is missing or its UUID changed')
    end
    local master = photo:getRawMetadata('masterPhoto') or photo
    if tostring(master.localIdentifier) ~= source.master_id or master:getRawMetadata('uuid') ~= source.master_uuid then
        error('Frozen source master changed')
    end
    return photo
end

local function captureAndVerifyReturnedCopies(source, returned)
    source.state = 'uncertain'
    source.failure = problem('creation_uncertain', 'Lightroom did not return exactly one verified virtual copy', source)
    if type(returned) ~= 'table' then return end
    local captured, seen = {}, {}
    for _, copy in ipairs(returned) do
        local ok, id = LrTasks.pcall(function() return copy.localIdentifier end)
        if ok and id ~= nil and not seen[tostring(id)] then
            seen[tostring(id)] = true
            local observed = { photo_id = source.photo_id, expected_master_id = source.master_id,
                copy_id = tostring(id), verified = false }
            source.observed[#source.observed + 1] = observed
            captured[#captured + 1] = { photo = copy, observed = observed }
        end
    end
    for _, entry in ipairs(captured) do
        local ok, valid = LrTasks.pcall(function()
            local copy = entry.photo
            local master = copy:getRawMetadata('masterPhoto')
            return entry.observed.copy_id ~= source.photo_id and entry.observed.copy_id ~= source.master_id
                and copy:getRawMetadata('isVirtualCopy') == true and master ~= nil
                and tostring(master.localIdentifier) == source.master_id
                and master:getRawMetadata('uuid') == source.master_uuid
                and copy:getRawMetadata('uuid') ~= nil
        end)
        if ok and valid then
            entry.observed.verified = true
            source.copies[#source.copies + 1] = { photo_id = source.photo_id,
                master_id = source.master_id, copy_id = entry.observed.copy_id }
        end
    end
    if #returned == 1 and #source.copies == 1 then
        source.state, source.failure = 'recorded', nil
    end
end

local function execute(context)
    local catalog, record = context.catalog, context.record
    for _, source in ipairs(record.sources) do
        if source.state == 'attempting' or source.state == 'uncertain' then return snapshot(record, context.id) end
    end
    local hasPending = false
    for _, source in ipairs(record.sources) do hasPending = hasPending or source.state == 'pending' end
    if not hasPending then return snapshot(record, context.id) end
    local active = catalog:getTargetPhoto()
    local selection = active and catalog:getTargetPhotos() or {}
    local sources = catalog:getActiveSources()
    local switchedSource = false
    local ok, failure = LrTasks.pcall(function()
        for _, source in ipairs(record.sources) do
            if source.state == 'pending' then
                local resolved, photo = LrTasks.pcall(frozenPhoto, catalog, source)
                if not resolved then
                    context.failure = problem('source_unavailable', photo, source)
                    break
                end
                local selected, selectionFailure = LrTasks.pcall(function()
                    if select(catalog, photo, { photo }) then return end
                    switchedSource = true
                    catalog:setActiveSources({ catalog.kAllPhotos })
                    if not select(catalog, photo, { photo }) then error('Could not select photo ' .. source.photo_id) end
                end)
                if not selected then
                    context.failure = problem('selection_failed', selectionFailure, source)
                    break
                end
                source.state = 'attempting'
                if not checkpoint(context) then break end
                local selectedPhotos = catalog:getTargetPhotos() or {}
                if catalog:getTargetPhoto() ~= photo or not samePhotos(selectedPhotos, { photo }) then
                    source.state = 'pending'
                    context.failure = problem('selection_failed', 'Photo selection changed before creation', source)
                    checkpoint(context)
                    break
                end
                local created, returned = LrTasks.pcall(function() return catalog:createVirtualCopies(record.request.copy_name) end)
                if created then
                    captureAndVerifyReturnedCopies(source, returned)
                else
                    source.state = 'uncertain'
                    source.failure = problem('creation_uncertain', returned, source)
                end
                if not checkpoint(context) or source.state == 'uncertain' then break end
            end
        end
    end)
    if not ok then context.failure = problem('operation_failed', failure) end
    local restored, restoreFailure = LrTasks.pcall(function()
        if switchedSource then
            catalog:setActiveSources(sources)
            if not DevelopSession.waitFor(function()
                return samePhotos(catalog:getActiveSources() or {}, sources)
            end, 10) then error('Could not restore the previous view source') end
        end
        if not select(catalog, active, selection) then error('Could not restore the previous photo selection') end
    end)
    return snapshot(record, context.id, context.failure, not restored and tostring(restoreFailure) or nil,
        context.failure and context.failure.code == 'checkpoint_failed' and 'blocked' or nil)
end

function Handler.create(args)
    local request, operationId = normalize(args)
    local catalog = LrApplication.activeCatalog()
    local context = { catalog = catalog, id = operationId, key = operationId and propertyKey(operationId) }
    if context.key then
        local identified, catalogPath = LrTasks.pcall(function() return catalog:getPath() end)
        if not identified or not nonempty(catalogPath) then
            return snapshot(nil, operationId, problem('catalog_unavailable', 'Could not identify the active catalog'), nil, 'blocked')
        end
        context.catalogPath = catalogPath
    end
    local preflightFailure
    local ok, result = LrTasks.pcall(function()
        return DevelopSession.run('create_virtual_copies', catalog, false, function()
            if context.key then
                local supplemental = (blockedResultsByCatalog[context.catalogPath] or {})[context.key]
                if supplemental then
                    context.record = supplemental.record
                    if not sameRequest(context.record.request, request) then
                        return snapshot(context.record, operationId,
                            problem('operation_conflict', 'operation_id already belongs to a different ordered request'), nil, 'conflict')
                    end
                    return snapshot(context.record, operationId, supplemental.failure, nil, 'blocked')
                end
                local loaded, record, raw = LrTasks.pcall(load, catalog, context.key)
                if not loaded then return snapshot(nil, operationId, problem('invalid_operation_record', record), nil, 'blocked') end
                context.record, context.raw = record, raw
                if context.record and not sameRequest(context.record.request, request) then
                    return snapshot(context.record, operationId,
                        problem('operation_conflict', 'operation_id already belongs to a different ordered request'), nil, 'conflict')
                end
            end
            if not context.record then
                context.record = plan(catalog, request)
                if #context.record.sources == 0 then
                    preflightFailure = 'No photos matched photo_ids'
                    error(preflightFailure)
                end
                if not checkpoint(context) then return snapshot(context.record, operationId, context.failure, nil, 'blocked') end
            end
            return execute(context)
        end)
    end)
    if preflightFailure then error(preflightFailure, 0) end
    if ok then return result end
    if context.key then
        local blocked = (blockedResultsByCatalog[context.catalogPath] or {})[context.key]
        if blocked then
            context.record = blocked.record
            if not sameRequest(context.record.request, request) then
                return snapshot(context.record, operationId,
                    problem('operation_conflict', 'operation_id already belongs to a different ordered request'), nil, 'conflict')
            end
            return snapshot(context.record, operationId, blocked.failure, nil, 'blocked')
        end
        if not context.record then
            local loaded, record = LrTasks.pcall(load, catalog, context.key)
            if loaded then context.record = record end
        end
    end
    return snapshot(context.record, operationId, problem('operation_blocked', result), nil, 'blocked')
end

return Handler
