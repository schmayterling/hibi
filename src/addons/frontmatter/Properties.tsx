import {
  Braces,
  CheckSquare,
  ChevronDown,
  Code,
  Hash,
  List,
  Plus,
  Type,
  X,
} from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { isMap, isScalar, isSeq, parseDocument } from 'yaml'
import type { MarkdownEditorProps } from '../api'
import { Button, IconButton, Select, TextArea, TextInput, Toggle } from '../ui'
import { replaceFrontmatter, splitFrontmatter, yamlLines } from './markdown'
import { propertiesExpanded } from './preferences'
import './frontmatter.css'

function NumberProperty({
  id,
  value,
  disabled,
  onChange,
}: {
  id: string
  value: number | bigint
  disabled: boolean
  onChange: (value: number | bigint) => void
}) {
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (input.current && document.activeElement !== input.current)
      input.current.value = String(value)
  }, [value])
  return (
    <TextInput
      variant="subtle"
      id={id}
      ref={input}
      type="number"
      step="any"
      defaultValue={String(value)}
      disabled={disabled}
      onBlur={(event) => {
        event.currentTarget.value = String(value)
      }}
      onChange={(event) => {
        const text = event.currentTarget.value
        if (
          !text ||
          !event.currentTarget.validity.valid ||
          !Number.isFinite(Number(text))
        )
          return
        onChange(/^-?\d+$/.test(text) ? BigInt(text) : Number(text))
      }}
    />
  )
}

export function Properties({ value, onChange, disabled }: MarkdownEditorProps) {
  const block = splitFrontmatter(value)
  const yaml = block?.yaml ?? ''
  const doc = useMemo(
    () => parseDocument(yamlLines(yaml), { intAsBigInt: true }),
    [yaml],
  )
  const [open, setOpen] = useState(propertiesExpanded)
  const [raw, setRaw] = useState(false)
  const [draft, setDraft] = useState('')
  const [draftBase, setDraftBase] = useState('')
  const [name, setName] = useState('')
  const [adding, setAdding] = useState(false)
  const addInput = useRef<HTMLInputElement>(null)
  const [kind, setKind] = useState('text')
  const [error, setError] = useState('')
  const id = useId()
  useEffect(() => {
    if (adding) addInput.current?.focus()
  }, [adding])
  if (!block) return null
  const mapping =
    isMap(doc.contents) &&
    doc.contents.items.every(
      (item) => isScalar(item.key) && typeof item.key.value === 'string',
    )
  const formAvailable = !doc.errors.length && (!doc.contents || mapping)
  const items = mapping && isMap(doc.contents) ? doc.contents.items : []

  function editYaml() {
    setDraft(yaml)
    setDraftBase(yaml)
    setRaw(true)
    setError('')
  }
  function save(key: string, fieldValue: unknown, remove = false) {
    try {
      const next = doc.clone()
      if (remove) next.delete(key)
      else next.set(key, fieldValue)
      onChange(replaceFrontmatter(value, next.toString({ lineWidth: 0 })))
      setError('')
    } catch (error) {
      setError(
        error instanceof Error ? error.message : 'Could not update properties.',
      )
    }
  }

  return (
    <section className="frontmatter" aria-label="Frontmatter properties">
      <div className="frontmatter-heading">
        <Button
          variant="ghost"
          type="button"
          className="frontmatter-toggle"
          aria-expanded={open}
          aria-controls={`${id}-body`}
          onClick={() => setOpen(!open)}
        >
          <ChevronDown aria-hidden="true" />
          <span>Properties</span>
          <span className="frontmatter-count">{items.length}</span>
        </Button>
        <Button
          variant="ghost"
          type="button"
          className="frontmatter-yaml-toggle"
          onClick={() => {
            setOpen(true)
            if (raw) {
              setRaw(false)
              setError('')
            } else editYaml()
          }}
        >
          <Code size={14} aria-hidden="true" />
          {raw ? 'Fields' : 'YAML'}
        </Button>
      </div>
      <div
        className="frontmatter-disclosure"
        data-open={open}
        id={`${id}-body`}
        inert={!open}
      >
        <div className="frontmatter-body">
          {raw ? (
            <form
              className="frontmatter-raw"
              onSubmit={(event) => {
                event.preventDefault()
                if (yaml !== draftBase) return
                const parsed = parseDocument(draft, { intAsBigInt: true })
                if (
                  parsed.errors.length ||
                  (draft.trim() && !isMap(parsed.contents)) ||
                  /^(?:---|\.\.\.)[ \t]*$/m.test(draft)
                ) {
                  setError(
                    parsed.errors[0]?.message ??
                      'Enter YAML properties as name: value pairs, without the surrounding --- lines.',
                  )
                  return
                }
                onChange(
                  replaceFrontmatter(value, draft.trim() ? draft : '{}\n'),
                )
                setRaw(false)
                setError('')
              }}
            >
              <TextArea
                monospace
                aria-label="Frontmatter YAML"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                disabled={disabled}
                spellCheck={false}
                rows={Math.min(14, Math.max(4, draft.split('\n').length))}
              />
              <div className="frontmatter-actions">
                <Button
                  type="button"
                  onClick={() => {
                    setRaw(false)
                    setError('')
                  }}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={disabled || yaml !== draftBase}>
                  Apply YAML
                </Button>
              </div>
              {yaml !== draftBase && (
                <p role="alert">
                  Properties changed in Markdown. cancel and reopen YAML to edit
                  the latest values.
                </p>
              )}
            </form>
          ) : formAvailable ? (
            <>
              <div className="frontmatter-fields">
                {items.map((pair, index) => {
                  const key = String(isScalar(pair.key) ? pair.key.value : '')
                  const node = pair.value
                  const inputId = `${id}-${index}`
                  const scalar = isScalar(node) ? node.value : undefined
                  const PropertyIcon =
                    typeof scalar === 'boolean'
                      ? CheckSquare
                      : typeof scalar === 'number' || typeof scalar === 'bigint'
                        ? Hash
                        : isSeq(node)
                          ? List
                          : isMap(node)
                            ? Braces
                            : Type
                  return (
                    <div className="frontmatter-field" key={key}>
                      <label htmlFor={inputId}>
                        <PropertyIcon aria-hidden="true" />
                        {key}
                      </label>
                      {typeof scalar === 'boolean' ? (
                        <Toggle
                          id={inputId}
                          disabled={disabled}
                          checked={scalar}
                          onChange={(event) => {
                            save(key, event.target.checked)
                          }}
                        />
                      ) : typeof scalar === 'string' ? (
                        <TextArea
                          variant="subtle"
                          id={inputId}
                          value={scalar}
                          placeholder="Empty"
                          rows={Math.min(
                            5,
                            Math.max(1, scalar.split('\n').length),
                          )}
                          disabled={disabled}
                          onChange={(event) => {
                            save(key, event.target.value)
                          }}
                        />
                      ) : typeof scalar === 'number' ||
                        typeof scalar === 'bigint' ? (
                        <NumberProperty
                          id={inputId}
                          value={scalar}
                          disabled={disabled}
                          onChange={(value) => save(key, value)}
                        />
                      ) : (
                        <Button
                          variant="row"
                          id={inputId}
                          type="button"
                          className="frontmatter-complex"
                          onClick={editYaml}
                        >
                          {isSeq(node) &&
                          node.items.every(
                            (item) =>
                              isScalar(item) &&
                              ['string', 'number', 'boolean'].includes(
                                typeof item.value,
                              ),
                          ) ? (
                            <span className="frontmatter-tags">
                              {node.items.length
                                ? node.items.map((item) => (
                                    <span
                                      className="frontmatter-tag"
                                      key={
                                        isScalar(item)
                                          ? item.range?.[0]
                                          : String(item)
                                      }
                                    >
                                      {String(isScalar(item) ? item.value : '')}
                                    </span>
                                  ))
                                : 'Empty'}
                            </span>
                          ) : isSeq(node) ? (
                            `${node.items.length} items`
                          ) : isMap(node) ? (
                            `${node.items.length} fields`
                          ) : scalar === null ? (
                            'Empty'
                          ) : (
                            'Edit YAML'
                          )}
                        </Button>
                      )}
                      <IconButton
                        className="frontmatter-remove"
                        aria-label={`Remove ${key}`}
                        disabled={disabled}
                        onClick={() => {
                          save(key, undefined, true)
                        }}
                      >
                        <X />
                      </IconButton>
                    </div>
                  )
                })}
              </div>
              {adding ? (
                <form
                  className="frontmatter-add"
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      setAdding(false)
                      setName('')
                      setError('')
                    }
                  }}
                  onSubmit={(event) => {
                    event.preventDefault()
                    const key = name.trim()
                    if (!key) return
                    if (doc.has(key)) {
                      setError('A property with that name already exists.')
                      return
                    }
                    save(
                      key,
                      kind === 'number'
                        ? 0
                        : kind === 'boolean'
                          ? false
                          : kind === 'list'
                            ? []
                            : kind === 'object'
                              ? {}
                              : '',
                    )
                    setName('')
                    setAdding(false)
                  }}
                >
                  <TextInput
                    ref={addInput}
                    aria-label="New property name"
                    placeholder="Add property"
                    value={name}
                    disabled={disabled}
                    onChange={(event) => setName(event.target.value)}
                  />
                  <Select
                    aria-label="New property type"
                    value={kind}
                    disabled={disabled}
                    onChange={(event) => setKind(event.target.value)}
                  >
                    <option value="text">Text</option>
                    <option value="number">Number</option>
                    <option value="boolean">Boolean</option>
                    <option value="list">List</option>
                    <option value="object">Object</option>
                  </Select>
                  <IconButton
                    type="submit"
                    aria-label="Add property"
                    disabled={disabled || !name.trim()}
                  >
                    <Plus />
                  </IconButton>
                </form>
              ) : (
                <Button
                  variant="ghost"
                  type="button"
                  className="frontmatter-add-trigger"
                  disabled={disabled}
                  onClick={() => setAdding(true)}
                >
                  <Plus aria-hidden="true" />
                  Add property
                </Button>
              )}
            </>
          ) : (
            <div className="frontmatter-invalid">
              <p>
                {doc.errors[0]?.message ??
                  'Use Edit YAML to change these properties.'}
              </p>
              <Button type="button" onClick={editYaml}>
                Edit YAML
              </Button>
            </div>
          )}
          {error && (
            <p role="alert" className="frontmatter-error">
              {error}
            </p>
          )}
        </div>
      </div>
    </section>
  )
}
