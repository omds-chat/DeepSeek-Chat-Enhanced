import clsx from 'clsx'
import type { AnchorHTMLAttributes, ReactNode } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { formatSize, getExtension } from '../../services/attachments.js'
import { IconCloseFill14, IconRefreshOutline16 } from '../base/icons.js'
import { FileIcon } from './FileIcon.js'
import styles from './FileCard.module.css'

/**
 * 文档文件卡片：图标 + 文件名 + 「扩展名 大小」或状态文案。
 * 打开或下载由 link（链接属性）承载，卡片内渲染覆盖全卡的链接元素；
 * 上传失败时点击整卡走重试，可重试时显示刷新图标，不可重试时常显红色删除按钮。
 */
export const FileCard = ({
  name,
  size,
  status = 'done',
  error,
  onRetry,
  onRemove,
  link,
}: {
  name: string
  size: number
  status?: 'uploading' | 'done' | 'error'
  error?: string
  onRetry?: () => void
  onRemove?: () => void
  /** 上传完成后的链接属性；打开或下载的规则由调用方给出 */
  link?: AnchorHTMLAttributes<HTMLAnchorElement>
}) => {
  const t = useTranslate()
  const ext = getExtension(name)
  let icon: ReactNode = <FileIcon ext={ext} />
  let description = [ext, formatSize(size)].filter(Boolean).join(' ')
  if (status === 'uploading') {
    icon = <span className={styles.spinner} />
    description = t('uploadFileStatusUploading')
  } else if (status === 'error') {
    // 不可重试（过大、格式不支持）时保留文件图标并显示原因
    if (onRetry) {
      icon = <IconRefreshOutline16 />
    }
    description = error ?? t('uploadFileStatusFailed')
  }
  // 失败只走重试；上传完成后由链接元素承载打开或下载
  const retry = status === 'error' ? onRetry : undefined
  const openLink = status === 'done' ? link : undefined
  return (
    <div
      className={clsx(
        styles.card,
        onRemove && styles.editable,
        status === 'error' && (onRemove || onRetry) && styles.failed,
        (retry || openLink) && styles.clickable
      )}
      title={
        status === 'error'
          ? onRetry
            ? t('uploadRetry', { message: description })
            : description
          : name
      }
      onClick={retry}
    >
      {openLink ? <a className={styles.link} {...openLink} aria-label={name} /> : null}
      <div className={clsx(styles.icon, status === 'error' && onRetry && styles.retry)}>{icon}</div>
      <div className={styles.content}>
        <div className={styles.caption}>{name}</div>
        <div className={styles.subCaption}>{description}</div>
      </div>
      {onRemove ? (
        <button
          type="button"
          className={clsx(styles.remove, status === 'error' && !onRetry && styles.invalidRemove)}
          aria-label={t('delete')}
          onClick={(event) => {
            event.stopPropagation()
            onRemove()
          }}
        >
          <IconCloseFill14 />
        </button>
      ) : null}
    </div>
  )
}
