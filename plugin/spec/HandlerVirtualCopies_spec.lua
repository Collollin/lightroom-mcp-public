local helper = require 'spec_helper'
local JSON = require 'JSON'

describe('HandlerVirtualCopies', function()
    local Handler, catalog, photos, calls, state, options, properties, insidePrivate

    local function setup(opts)
        opts = opts or {}
        options = opts
        properties = opts.properties or {}
        insidePrivate = false
        photos = {}
        for i = 1, 3 do
            photos[i] = helper.fakePhoto({ id = tostring(i), path = '/' .. i .. '.jpg' })
        end
        if opts.virtualInput then
            photos[3] = helper.fakePhoto({ id = '3', path = '/1.jpg',
                isVirtualCopy = true, masterPhoto = photos[1] })
        end
        local source = {}
        state = { active = photos[1], selected = { photos[1], photos[2] }, sources = { source } }
        if opts.empty then state.active, state.selected = nil, {} end
        calls = { create = {}, selection = {}, sources = {}, writes = 0, pathLookups = 0 }
        local pendingProperties
        catalog = helper.fakeCatalog({ photos = photos })
        catalog.kAllPhotos = 'all'
        catalog.getPath = function() return opts.catalogPath or '/catalog/throwaway.lrcat' end
        catalog.getPropertyForPlugin = function(_, _, key)
            if opts.failReadAfterCreate and #calls.create > 0 then error('property read failed') end
            return properties[key]
        end
        catalog.setPropertyForPlugin = function(_, _, key, value)
            assert.is_true(insidePrivate)
            assert.are.equal('string', type(value))
            if opts.failWriteAt == calls.writes then error('property write failed') end
            if not opts.dropWrites then
                local target = opts.deferPropertyVisibility and pendingProperties or properties
                target[key] = value
            end
        end
        catalog.withPrivateWriteAccessDo = function(_, fn)
            calls.writes = calls.writes + 1
            if opts.beforeWrite then opts.beforeWrite(properties, calls.writes) end
            local previous = {}
            for key, value in pairs(properties) do previous[key] = value end
            pendingProperties = {}
            insidePrivate = true
            local ok, failure = pcall(function() catalog:withWriteAccessDo('private fixture', fn) end)
            insidePrivate = false
            if ok then
                for key, value in pairs(pendingProperties) do properties[key] = value end
            end
            if opts.afterWrite then opts.afterWrite(calls.writes) end
            if not ok then
                for key in pairs(properties) do properties[key] = nil end
                for key, value in pairs(previous) do properties[key] = value end
                error(failure)
            end
        end
        local findPath = catalog.findPhotoByPath
        catalog.findPhotoByPath = function(self, path)
            calls.pathLookups = calls.pathLookups + 1
            if opts.onPathLookup then opts.onPathLookup() end
            return findPath(self, path)
        end
        local getTargets = catalog.getTargetPhotos
        local setSelected = catalog.setSelectedPhotos
        catalog.getTargetPhoto = function() return state.active end
        catalog.getTargetPhotos = function(self)
            getTargets(self)
            return state.selected
        end
        catalog.getActiveSources = function() return state.sources end
        catalog.setActiveSources = function(_, sources)
            calls.sources[#calls.sources + 1] = sources
            state.sources = sources
        end
        catalog.setSelectedPhotos = function(self, active, selected)
            setSelected(self, active, selected)
            calls.selection[#calls.selection + 1] = { active = active, photos = selected }
            if opts.failRestore and #calls.create > 0 and active == photos[1] then return end
            if opts.failSelectionId == tostring(active.localIdentifier) then return end
            if opts.restricted and active == photos[3] and state.sources[1] ~= 'all' then return end
            state.active, state.selected = active, selected
        end
        catalog.createVirtualCopies = function(_, name)
            assert.is_false(catalog.isInsideReadAccess())
            assert.is_false(insidePrivate)
            assert.are.equal(1, #state.selected)
            calls.create[#calls.create + 1] = { photo = state.active, name = name }
            if opts.failCreate or opts.failCreateAt == #calls.create then error('SDK failure') end
            local master = opts.wrongMaster and photos[1] or state.active:getRawMetadata('masterPhoto') or state.active
            local copies = {}
            for index = 1, opts.returnCount or 1 do
                local copy = helper.fakePhoto({ id = tostring(100 + #calls.create + (index - 1) * 1000),
                    path = master:getRawMetadata('path'), isVirtualCopy = true, masterPhoto = master })
                photos[#photos + 1] = copy
                local siblings = master:getRawMetadata('virtualCopies') or {}
                siblings[#siblings + 1] = copy
                master:setRawMetadata('virtualCopies', siblings)
                if opts.metadataError and index == 1 then
                    copy.getRawMetadata = function() error('metadata unavailable') end
                end
                copies[index] = copy
            end
            if opts.duplicateReturn and copies[1] then copies[2] = copies[1] end
            if opts.throwAfterCreate then error('SDK threw after mutation') end
            state.active, state.selected = copies[1], copies
            return copies
        end
        helper.installImport({
            LrApplication = { activeCatalog = function() return catalog end },
            LrApplicationView = {},
            LrDevelopController = {},
            LrLogger = helper.defaultLrLogger(),
            LrSelection = { selectNone = function() state.active, state.selected = nil, {} end },
            LrTasks = { pcall = pcall, sleep = function() end },
        })
        package.loaded.DevelopSession = nil
        package.loaded.HandlerVirtualCopies = nil
        Handler = require 'HandlerVirtualCopies'
    end

    local function assertRestored()
        assert.are.equal(photos[1], state.active)
        assert.are.same({ photos[1], photos[2] }, state.selected)
        local last = calls.selection[#calls.selection]
        assert.are.equal(photos[1], last.active)
        assert.are.same({ photos[1], photos[2] }, last.photos)
    end

    it('creates named copies and returns stable photo, master and copy ids', function()
        setup()
        local result = Handler.create({ photo_ids = { '3', '2' }, copy_name = 'Experiment' })
        assert.are.equal(2, result.created)
        assert.are.same({
            { photo_id = '3', master_id = '3', copy_id = '101' },
            { photo_id = '2', master_id = '2', copy_id = '102' },
        }, result.copies)
        assert.are.equal('Experiment', calls.create[1].name)
        assert.are.equal('Experiment', calls.create[2].name)
        assertRestored()
        assert.is_false(catalog.getQueriedInsideReadAccess())
        assert.is_false(catalog.getQueriedInsideWriteAccess())
        assert.are.equal(0, catalog.getReadAccessCount())
        assert.are.equal(0, catalog.getWriteAccessCount())
    end)

    it('deduplicates ids and paths to the same photo and reports missing ids', function()
        setup()
        local result = Handler.create({ photo_ids = { '3', '3', '/3.jpg', '999' } })
        assert.are.equal(1, result.created)
        assert.are.same({ '999' }, result.missing)
        assert.is_nil(calls.create[1].name)
        assertRestored()
    end)

    it('selects only the requested photo even when it is already active', function()
        setup()
        Handler.create({ photo_ids = { '1' } })
        assert.are.equal(1, #calls.create)
        assert.are.equal(photos[1], calls.create[1].photo)
        assertRestored()
    end)

    it('returns the original master when the input is itself a virtual copy', function()
        setup({ virtualInput = true })
        local result = Handler.create({ photo_ids = { '3', '1' } })
        assert.are.equal(2, result.created)
        assert.are.same({ photo_id = '3', master_id = '1', copy_id = '101' }, result.copies[1])
        assert.are.same({ photo_id = '1', master_id = '1', copy_id = '102' }, result.copies[2])
        assertRestored()
    end)

    it('restores the view source after falling back to All Photographs', function()
        setup({ restricted = true })
        local originalSources = state.sources
        Handler.create({ photo_ids = { '3' } })
        assert.are.equal('all', calls.sources[1][1])
        assert.are.same(originalSources, state.sources)
        assertRestored()
    end)

    it('restores an empty selection', function()
        setup({ empty = true })
        Handler.create({ photo_ids = { '3' } })
        assert.is_nil(state.active)
        assert.are.same({}, state.selected)
    end)

    it('restores selection when the SDK fails and releases the session lock', function()
        setup({ failCreate = true })
        local result = Handler.create({ photo_ids = { '3' } })
        assert.are.equal('uncertain', result.status)
        assert.matches('SDK failure', result.failure.message, 1, true)
        assertRestored()
        result = Handler.create({ photo_ids = { '3' } })
        assert.are.equal('uncertain', result.status)
        assert.matches('SDK failure', result.failure.message, 1, true)
    end)

    it('reports a failed selection restore', function()
        setup({ failRestore = true })
        local result = Handler.create({ photo_ids = { '3' } })
        assert.are.equal('complete', result.status)
        assert.are.equal(1, result.created)
        assert.matches('Could not restore the previous photo selection', result.restoration_error, 1, true)
    end)

    it('leaves selection untouched when no photo resolves', function()
        setup()
        assert.has_error(function() Handler.create({ photo_ids = { '999' } }) end,
            'No photos matched photo_ids')
        assert.are.same({}, calls.selection)
        assert.are.same({}, calls.create)
    end)

    it('rejects malformed inputs before changing the selection', function()
        setup()
        for _, args in ipairs({ {}, { photo_ids = {} }, { photo_ids = { false } },
            { photo_ids = { '3' }, copy_name = ' ' } }) do
            assert.has_error(function() Handler.create(args) end)
        end
        local ids = {}
        for i = 1, 26 do ids[i] = '3' end
        assert.has_error(function() Handler.create({ photo_ids = ids }) end)
        assert.are.same({}, calls.selection)
    end)
    local function named(ids, name, operationId)
        return { photo_ids = ids or { '3', '2' }, copy_name = name or 'Experiment',
            operation_id = operationId or 'retry-test' }
    end

    local function reload()
        package.loaded.HandlerVirtualCopies = nil
        Handler = require 'HandlerVirtualCopies'
    end

    it('commits named copies when property visibility waits for the write callback to return', function()
        setup({ deferPropertyVisibility = true })
        local request = named()
        local first = Handler.create(request)
        assert.are.equal('complete', first.status)
        assert.are.equal(2, first.created)
        assert.are.same({
            { photo_id = '3', master_id = '3', copy_id = '101' },
            { photo_id = '2', master_id = '2', copy_id = '102' },
        }, first.copies)
        reload()
        assert.are.same(first, Handler.create(request))
        assert.are.equal(2, #calls.create)
        assertRestored()
    end)

    it('replays a discarded result after module reload without resolving paths again', function()
        setup()
        local request = named({ '/3.jpg', 2 })
        local first = Handler.create(request)
        assert.are.equal('complete', first.status)
        assert.are.equal(2, #calls.create)
        assert.are.equal(1, calls.pathLookups)
        reload()
        local replay = Handler.create(named({ '/3.jpg', '2' }))
        assert.are.same(first, replay)
        assert.are.equal(2, #calls.create)
        assert.are.equal(1, calls.pathLookups)
        assert.are.equal(5, calls.writes)
        assert.is_false(catalog.getQueriedInsideReadAccess())
        assert.is_false(catalog.getQueriedInsideWriteAccess())
    end)

    it('returns aliases and frozen missing inputs on replay', function()
        setup()
        local request = named({ '3', '/3.jpg', '3', '/missing.jpg' })
        local first = Handler.create(request)
        assert.are.equal(1, first.created)
        assert.are.same({ '/missing.jpg' }, first.missing)
        assert.are.equal(4, #first.inputs)
        assert.are.same({ '101' }, first.inputs[1].copy_ids)
        assert.are.same(first.inputs[1].copy_ids, first.inputs[2].copy_ids)
        photos[#photos + 1] = helper.fakePhoto({ id = '999', path = '/missing.jpg' })
        local replay = Handler.create(request)
        assert.are.same(first, replay)
        assert.are.equal(1, #calls.create)
    end)

    it('conflicts on changed order, aliases, duplicates or name before lookup', function()
        setup()
        local first = Handler.create(named({ '/3.jpg', '2' }))
        local lookups = calls.pathLookups
        for _, request in ipairs({ named({ '2', '/3.jpg' }), named({ '3', '2' }),
            named({ '/3.jpg', '2', '2' }), named({ '/3.jpg', '2' }, 'Other') }) do
            local result = Handler.create(request)
            assert.are.equal('conflict', result.status)
            assert.are.equal('operation_conflict', result.failure.code)
            assert.are.same(first.copies, result.copies)
            assert.is_false(result.retryable)
        end
        assert.are.equal(lookups, calls.pathLookups)
        assert.are.equal(2, #calls.create)
    end)

    it('creates anew for different operation ids and for every unnamed call', function()
        setup()
        local a = Handler.create(named({ '3' }, 'Same', 'a'))
        local b = Handler.create(named({ '3' }, 'Same', 'b'))
        local c = Handler.create({ photo_ids = { '3' }, copy_name = 'Same' })
        local d = Handler.create({ photo_ids = { '3' }, copy_name = 'Same' })
        assert.are.equal(4, #calls.create)
        assert.are.same({ '101', '102', '103', '104' }, {
            a.copies[1].copy_id, b.copies[1].copy_id, c.copies[1].copy_id, d.copies[1].copy_id })
        assert.are.equal(6, calls.writes)
    end)

    it('resumes only pending sources after a selection failure', function()
        setup({ failSelectionId = '2' })
        local first = Handler.create(named())
        assert.are.equal('partial', first.status)
        assert.is_true(first.retryable)
        assert.are.equal('selection_failed', first.failure.code)
        assert.are.equal(1, first.created)
        assert.are.equal('pending', first.inputs[2].status)
        options.failSelectionId = nil
        reload()
        local replay = Handler.create(named())
        assert.are.equal('complete', replay.status)
        assert.are.equal(2, replay.created)
        assert.are.equal(first.copies[1].copy_id, replay.copies[1].copy_id)
        assert.are.equal(2, #calls.create)
        assert.are.equal(photos[2], calls.create[2].photo)
    end)

    it('blocks pending work when a frozen source UUID changes', function()
        setup({ failSelectionId = '2' })
        local first = Handler.create(named())
        photos[2]:setRawMetadata('uuid', 'replacement')
        options.failSelectionId = nil
        local result = Handler.create(named())
        assert.are.equal('source_unavailable', result.failure.code)
        assert.is_false(result.retryable)
        assert.are.same(first.copies, result.copies)
        assert.are.equal(1, #calls.create)
    end)

    it('preserves earlier copies when an SDK call throws and never resumes uncertainty', function()
        setup({ failCreateAt = 2 })
        local first = Handler.create(named({ '3', '2', '1' }))
        assert.are.equal('uncertain', first.status)
        assert.is_false(first.retryable)
        assert.are.equal(1, first.created)
        assert.are.equal('uncertain', first.inputs[2].status)
        assert.are.equal('pending', first.inputs[3].status)
        options.failCreateAt = nil
        reload()
        local replay = Handler.create(named({ '3', '2', '1' }))
        assert.are.same(first, replay)
        assert.are.equal(2, #calls.create)
        assertRestored()
    end)

    it('does not adopt a copy after the SDK mutates then throws', function()
        setup({ throwAfterCreate = true })
        local first = Handler.create(named({ '3' }))
        assert.are.equal('uncertain', first.status)
        assert.are.equal(0, first.created)
        assert.are.same({}, first.observed_copies)
        assert.are.equal(1, #photos[3]:getRawMetadata('virtualCopies'))
        options.throwAfterCreate = false
        reload()
        local replay = Handler.create(named({ '3' }))
        assert.are.same(first, replay)
        assert.are.equal(1, #calls.create)
    end)

    it('preserves every returned ID before verifying any metadata', function()
        setup({ returnCount = 2, metadataError = true })
        local result = Handler.create(named({ '3', '2' }))
        assert.are.equal('uncertain', result.status)
        assert.are.equal(1, result.created)
        assert.are.same({ photo_id = '3', master_id = '3', copy_id = '1101' }, result.copies[1])
        assert.are.equal('101', result.observed_copies[1].copy_id)
        assert.is_false(result.observed_copies[1].verified)
        assert.are.equal('1101', result.observed_copies[2].copy_id)
        assert.is_true(result.observed_copies[2].verified)
        assert.are.same({ '101', '1101' }, result.inputs[1].copy_ids)
        reload()
        assert.are.same(result, Handler.create(named({ '3', '2' })))
        assert.are.equal(1, #calls.create)
    end)

    it('retains all verified mappings for an unexpected multiple return', function()
        setup({ returnCount = 2 })
        local result = Handler.create(named({ '3' }))
        assert.are.equal('uncertain', result.status)
        assert.are.equal(2, result.created)
        assert.are.equal(2, #result.observed_copies)
        assert.is_false(result.retryable)
    end)

    it('treats an empty SDK return as uncertain', function()
        setup({ returnCount = 0 })
        local result = Handler.create(named({ '3' }))
        assert.are.equal('uncertain', result.status)
        assert.are.equal(0, result.created)
        assert.are.equal(1, #calls.create)
    end)

    it('preserves named mappings through restoration failure', function()
        setup({ failRestore = true })
        local first = Handler.create(named({ '3' }))
        assert.are.equal('complete', first.status)
        assert.are.equal(1, first.created)
        assert.matches('restore', first.restoration_error)
        local replay = Handler.create(named({ '3' }))
        assert.are.same(first.copies, replay.copies)
        assert.are.equal('complete', replay.status)
        assert.are.equal(1, #calls.create)
    end)

    it('never replaces a recorded copy that was deleted', function()
        setup()
        local first = Handler.create(named({ '3' }))
        table.remove(photos, 4)
        photos[3]:setRawMetadata('virtualCopies', {})
        reload()
        assert.are.same(first, Handler.create(named({ '3' })))
        assert.are.equal(1, #calls.create)
        assert.are.equal(3, #photos)
    end)

    it('refuses SDK creation if the reservation or attempting checkpoint fails', function()
        for _, failAt in ipairs({ 1, 2 }) do
            setup({ failWriteAt = failAt })
            local first = Handler.create(named({ '3' }))
            assert.are.equal('checkpoint_failed', first.failure.code)
            assert.is_false(first.retryable)
            assert.are.equal(0, #calls.create)
            options.failWriteAt = nil
            local replay = Handler.create(named({ '3' }))
            assert.are.equal('blocked', replay.status)
            assert.are.equal(0, #calls.create)
        end
    end)

    it('retains known IDs in-process after a completion checkpoint failure', function()
        setup({ failWriteAt = 3 })
        local first = Handler.create(named())
        assert.are.equal(1, first.created)
        assert.are.equal('101', first.copies[1].copy_id)
        assert.are.equal('checkpoint_failed', first.failure.code)
        options.failWriteAt = nil
        local replay = Handler.create(named())
        assert.are.equal('blocked', replay.status)
        assert.are.same(first.copies, replay.copies)
        assert.are.same(first.observed_copies, replay.observed_copies)
        assert.is_false(replay.retryable)
        assert.are.equal(1, #calls.create)
        reload()
        local afterReload = Handler.create(named())
        assert.are.equal('uncertain', afterReload.status)
        assert.are.equal('creation_uncertain', afterReload.failure.code)
        assert.are.equal(0, afterReload.created)
        assert.are.equal(1, #calls.create)
    end)

    it('requires checkpoint readback before creating', function()
        setup({ dropWrites = true })
        local result = Handler.create(named())
        assert.are.equal('blocked', result.status)
        assert.are.equal('checkpoint_failed', result.failure.code)
        assert.are.equal(0, #calls.create)
    end)

    it('refuses a changed raw preimage without overwriting another runtime', function()
        setup({ beforeWrite = function(props, count)
            if count == 2 then
                for key in pairs(props) do props[key] = 'foreign runtime record' end
            end
        end })
        local result = Handler.create(named())
        assert.are.equal('checkpoint_failed', result.failure.code)
        assert.are.equal(0, #calls.create)
        for _, raw in pairs(properties) do assert.are.equal('foreign runtime record', raw) end
    end)

    it('refuses overlapping calls before selection or creation', function()
        setup()
        local overlap
        options.onPathLookup = function()
            options.onPathLookup = nil
            overlap = Handler.create(named({ '/3.jpg' }))
        end
        local result = Handler.create(named({ '/3.jpg' }))
        assert.are.equal('complete', result.status)
        assert.are.equal('blocked', overlap.status)
        assert.are.equal('operation_blocked', overlap.failure.code)
        assert.are.equal(1, #calls.create)
    end)

    it('fails closed on malformed, unknown-version and invalid state records', function()
        setup()
        Handler.create(named({ '3' }))
        local key, good = next(properties)
        local unknown = JSON:decode(good)
        unknown.version = 2
        local invalid = JSON:decode(good)
        invalid.sources[1].state = 'fresh'
        for _, raw in ipairs({ '{', '[]', good .. ' trailing garbage', good .. ']', good .. ',{}', JSON:encode(unknown), JSON:encode(invalid) }) do
            properties[key] = raw
            reload()
            local result = Handler.create(named({ '3' }))
            assert.are.equal('blocked', result.status)
            assert.are.equal('invalid_operation_record', result.failure.code)
            assert.are.equal(1, #calls.create)
        end
    end)

    it('isolates the same operation ID in distinct catalogs', function()
        setup()
        Handler.create(named({ '3' }))
        local firstProperties = properties
        setup()
        assert.are.equal('complete', Handler.create(named({ '3' })).status)
        assert.are.equal(1, #calls.create)
        assert.is_not.equal(firstProperties, properties)
    end)

    it('keeps partial mappings for an unnamed SDK failure', function()
        setup({ failCreateAt = 2 })
        local result = Handler.create({ photo_ids = { '3', '2' } })
        assert.are.equal('uncertain', result.status)
        assert.are.equal(1, result.created)
        assert.are.equal('101', result.copies[1].copy_id)
        assert.are.equal(0, calls.writes)
    end)

    it('rejects invalid operation IDs before any query or write', function()
        setup()
        for _, id in ipairs({ false, 42, '', ' ', string.rep('x', 129), string.rep('é', 65) }) do
            assert.has_error(function() Handler.create({ photo_ids = { '3' }, operation_id = id }) end)
        end
        assert.are.equal(0, calls.writes)
        assert.are.equal(0, #calls.create)
        assert.are.equal(0, #calls.selection)
    end)
    it('never marks an unnamed partial request safe to retry', function()
        setup({ failSelectionId = '2' })
        local result = Handler.create({ photo_ids = { '3', '2' } })
        assert.are.equal('partial', result.status)
        assert.are.equal(1, result.created)
        assert.is_false(result.retryable)
    end)

    it('rechecks exact selection after the attempting checkpoint yields', function()
        setup()
        options.afterWrite = function(count)
            if count == 2 then state.active, state.selected = photos[2], { photos[2] } end
        end
        local result = Handler.create(named({ '3' }))
        assert.are.equal('partial', result.status)
        assert.are.equal('selection_failed', result.failure.code)
        assert.is_true(result.retryable)
        assert.are.equal('pending', result.inputs[1].status)
        assert.are.equal(0, #calls.create)
        options.afterWrite = nil
        reload()
        assert.are.equal('complete', Handler.create(named({ '3' })).status)
        assert.are.equal(photos[3], calls.create[1].photo)
    end)

    it('reports blocked when the final checkpoint fails after all copies returned', function()
        setup({ failWriteAt = 3 })
        local result = Handler.create(named({ '3' }))
        assert.are.equal('blocked', result.status)
        assert.are.equal(1, result.created)
        assert.are.equal('checkpoint_failed', result.failure.code)
        assert.is_false(result.retryable)
    end)

    it('retains supplemental IDs when persistent reads fail on retry', function()
        setup({ failReadAfterCreate = true })
        local first = Handler.create(named({ '3' }))
        assert.are.equal('blocked', first.status)
        assert.are.equal(1, first.created)
        local replay = Handler.create(named({ '3' }))
        assert.are.equal('blocked', replay.status)
        assert.are.same(first.copies, replay.copies)
        assert.are.same(first.observed_copies, replay.observed_copies)
        assert.are.equal(1, #calls.create)
    end)

    it('retains supplemental IDs when a failed checkpoint leaves corrupt storage', function()
        setup({ failWriteAt = 3 })
        local first = Handler.create(named({ '3' }))
        for key in pairs(properties) do properties[key] = 'corrupt' end
        options.failWriteAt = nil
        local replay = Handler.create(named({ '3' }))
        assert.are.same(first.copies, replay.copies)
        assert.are.equal('blocked', replay.status)
        assert.are.equal(1, #calls.create)
    end)
    it('retains a wrong-master return as observed without adopting it', function()
        setup({ wrongMaster = true })
        local result = Handler.create(named({ '3' }))
        assert.are.equal('uncertain', result.status)
        assert.are.equal(0, result.created)
        assert.are.equal('101', result.observed_copies[1].copy_id)
        assert.are.equal('3', result.observed_copies[1].expected_master_id)
        assert.is_false(result.observed_copies[1].verified)
    end)

    it('counts a duplicated SDK-returned identity once and blocks further creation', function()
        setup({ duplicateReturn = true })
        local result = Handler.create(named())
        assert.are.equal('uncertain', result.status)
        assert.are.equal(1, result.created)
        assert.are.equal(1, #result.observed_copies)
        assert.are.equal(1, #calls.create)
    end)
    it('never reattempts after an attempting marker commits without an SDK outcome', function()
        setup({ afterWrite = function(count)
            if count == 2 then error('interrupted after committed attempt marker') end
        end })
        local result = Handler.create(named({ '3' }))
        assert.are.equal('checkpoint_failed', result.failure.code)
        assert.are.equal(0, #calls.create)
        options.afterWrite = nil
        reload()
        local recovered = Handler.create(named({ '3' }))
        assert.are.equal('uncertain', recovered.status)
        assert.is_false(recovered.retryable)
        assert.are.equal(0, #calls.create)
    end)

    it('compares raw absence before reserving a new operation', function()
        setup({ beforeWrite = function(props, count)
            if count == 1 then props['vcOperation.v1.72657472792d74657374'] = 'another runtime won' end
        end })
        local result = Handler.create(named())
        assert.are.equal('checkpoint_failed', result.failure.code)
        assert.are.equal('another runtime won', properties['vcOperation.v1.72657472792d74657374'])
        assert.are.equal(0, #calls.create)
    end)
    it('retains known IDs across equivalent catalog wrapper objects after checkpoint failure', function()
        setup({ failWriteAt = 3 })
        local first = Handler.create(named({ '3' }))
        assert.are.equal(1, first.created)
        local original = catalog
        catalog = setmetatable({}, { __index = original })
        assert.is_not.equal(original, catalog)
        assert.are.equal(original:getPath(), catalog:getPath())
        local replay = Handler.create(named({ '3' }))
        assert.are.equal('blocked', replay.status)
        assert.are.same(first.copies, replay.copies)
        assert.are.same(first.observed_copies, replay.observed_copies)
        assert.are.equal(1, #calls.create)
    end)

    it('retains known blocked IDs when another tool holds the Develop guard', function()
        setup({ failWriteAt = 3 })
        local first = Handler.create(named({ '3' }))
        local replay = require('DevelopSession').run('other-tool', catalog, false, function()
            return Handler.create(named({ '3' }))
        end)
        assert.are.equal('blocked', replay.status)
        assert.are.same(first.copies, replay.copies)
        assert.are.same(first.observed_copies, replay.observed_copies)
        assert.are.equal(1, #calls.create)
    end)
end)
