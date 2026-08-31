variable "project_id" { type = string }
variable "region" {
  type    = string
  default = "asia-northeast1"
}
variable "image_tag" { type = string }
variable "finance_absolute_max_amount" {
  type    = number
  default = 1000000
}
